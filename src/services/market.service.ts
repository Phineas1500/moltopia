import { db } from '../db/index.js';
import { marketOrders, marketTrades, items, inventory, accounts, agents, transactions } from '../db/schema.js';
import { eq, and, or, sql, desc, asc, ne, lt } from 'drizzle-orm';
import { PresenceService } from './presence.service.js';
import { SYSTEM_AGENT_ID } from '../constants/economy.js';

const EXCHANGE_LOCATION_ID = 'loc_exchange';
const DEFAULT_EXPIRE_ORDER_LIMIT = 250;

type ExpiredOrderResult = {
  expiredCount: number;
  buyOrderCount: number;
  sellOrderCount: number;
  refundedCents: number;
  returnedItemCount: number;
};

export const MarketService = {
  /**
   * Place a buy or sell order
   */
  async placeOrder(data: {
    agentId: string;
    itemId: string;
    orderType: 'buy' | 'sell';
    price: number; // In cents
    quantity: number;
    expiresInHours?: number;
    skipPresence?: boolean;
  }) {
    const { agentId, itemId, orderType, price, quantity, expiresInHours, skipPresence } = data;

    if (price <= 0) throw new Error('Price must be positive');
    if (quantity <= 0) throw new Error('Quantity must be positive');

    // Verify item exists
    const item = await db.query.items.findFirst({
      where: eq(items.id, itemId),
    });
    if (!item) throw new Error('Item not found');

    // Base elements have unlimited supply from the system — don't allow market trading
    if (item.category === 'base_element') {
      throw new Error('Base elements cannot be traded on the market. Buy them from the system: POST /crafting/elements/purchase ($10 each)');
    }

    // Prevent self-locking: reject if agent already has an opposite order at a matchable price
    const oppositeSide = orderType === 'buy' ? 'sell' : 'buy';
    const existingOpposite = await db.query.marketOrders.findFirst({
      where: and(
        eq(marketOrders.agentId, agentId),
        eq(marketOrders.itemId, itemId),
        eq(marketOrders.orderType, oppositeSide),
        eq(marketOrders.status, 'open')
      ),
    });
    if (existingOpposite) {
      const wouldLock = orderType === 'buy'
        ? price >= existingOpposite.price  // buying at or above own sell
        : price <= existingOpposite.price; // selling at or below own buy
      if (wouldLock) {
        const side = orderType === 'buy' ? 'sell' : 'buy';
        throw new Error(`You already have an open ${side} order for ${item.name} at $${existingOpposite.price / 100}. Cancel it first, or adjust your price.`);
      }
    }

    // For sell orders, verify agent has the items
    if (orderType === 'sell') {
      const inv = await db.query.inventory.findFirst({
        where: and(
          eq(inventory.agentId, agentId),
          eq(inventory.itemId, itemId)
        ),
      });

      if (!inv || inv.quantity < quantity) {
        throw new Error(`Insufficient inventory. You have ${inv?.quantity || 0}, need ${quantity}`);
      }

      // Reserve the items (reduce inventory)
      if (inv.quantity === quantity) {
        await db.delete(inventory).where(eq(inventory.id, inv.id));
      } else {
        await db
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} - ${quantity}` })
          .where(eq(inventory.id, inv.id));
      }
    }

    // For buy orders, verify agent has funds
    if (orderType === 'buy') {
      const totalCost = price * quantity;
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.agentId, agentId),
      });

      if (!account || account.balance < totalCost) {
        throw new Error(`Insufficient funds. You have $${(account?.balance || 0) / 100}, need $${totalCost / 100}`);
      }

      // Reserve the funds
      await db
        .update(accounts)
        .set({
          balance: sql`${accounts.balance} - ${totalCost}`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.agentId, agentId));
    }

    const orderId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = expiresInHours
      ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Default 7 days

    // Move agent to The Exchange for player actions.
    if (!skipPresence) {
      await PresenceService.moveAgent(agentId, EXCHANGE_LOCATION_ID);
    }

    // Create the order
    const [order] = await db.insert(marketOrders).values({
      id: orderId,
      agentId,
      itemId,
      orderType,
      price,
      quantity,
      filledQuantity: 0,
      status: 'open',
      expiresAt,
    }).returning();

    // Try to match with existing orders
    await this.matchOrders(itemId);

    // Return updated order
    return db.query.marketOrders.findFirst({
      where: eq(marketOrders.id, orderId),
      with: { item: true },
    });
  },

  /**
   * Match buy and sell orders for an item
   */
  async matchOrders(itemId: string) {
    // Get open buy orders (highest price first)
    const buyOrders = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.itemId, itemId),
        eq(marketOrders.orderType, 'buy'),
        eq(marketOrders.status, 'open')
      ),
      orderBy: [desc(marketOrders.price), asc(marketOrders.createdAt)],
    });

    // Get open sell orders (lowest price first)
    const sellOrders = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.itemId, itemId),
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open')
      ),
      orderBy: [asc(marketOrders.price), asc(marketOrders.createdAt)],
    });

    for (const buyOrder of buyOrders) {
      for (const sellOrder of sellOrders) {
        // Skip if same agent
        if (buyOrder.agentId === sellOrder.agentId) continue;

        // Check if prices match (buyer willing to pay >= seller asking)
        if (buyOrder.price < sellOrder.price) continue;

        // Calculate how much can be traded
        const buyRemaining = buyOrder.quantity - buyOrder.filledQuantity;
        const sellRemaining = sellOrder.quantity - sellOrder.filledQuantity;
        const tradeQuantity = Math.min(buyRemaining, sellRemaining);

        if (tradeQuantity <= 0) continue;

        // Execute trade at seller's price (price improvement for buyer)
        const tradePrice = sellOrder.price;

        // Record the trade
        const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await db.insert(marketTrades).values({
          id: tradeId,
          itemId,
          buyerId: buyOrder.agentId,
          sellerId: sellOrder.agentId,
          price: tradePrice,
          quantity: tradeQuantity,
          buyOrderId: buyOrder.id,
          sellOrderId: sellOrder.id,
        });

        // Update order filled quantities
        const newBuyFilled = buyOrder.filledQuantity + tradeQuantity;
        const newSellFilled = sellOrder.filledQuantity + tradeQuantity;

        await db
          .update(marketOrders)
          .set({
            filledQuantity: newBuyFilled,
            status: newBuyFilled >= buyOrder.quantity ? 'filled' : 'open',
          })
          .where(eq(marketOrders.id, buyOrder.id));

        await db
          .update(marketOrders)
          .set({
            filledQuantity: newSellFilled,
            status: newSellFilled >= sellOrder.quantity ? 'filled' : 'open',
          })
          .where(eq(marketOrders.id, sellOrder.id));

        if (buyOrder.agentId === SYSTEM_AGENT_ID) {
          // World demand consumes purchased items so supply actually leaves circulation.
          await db.update(items)
            .set({ currentSupply: sql`GREATEST(${items.currentSupply} - ${tradeQuantity}, 0)` })
            .where(eq(items.id, itemId));
        } else {
          // Transfer items to buyer
          const existingInv = await db.query.inventory.findFirst({
            where: and(
              eq(inventory.agentId, buyOrder.agentId),
              eq(inventory.itemId, itemId)
            ),
          });

          if (existingInv) {
            await db
              .update(inventory)
              .set({ quantity: sql`${inventory.quantity} + ${tradeQuantity}` })
              .where(eq(inventory.id, existingInv.id));
          } else {
            const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            await db.insert(inventory).values({
              id: invId,
              agentId: buyOrder.agentId,
              itemId,
              quantity: tradeQuantity,
              acquiredPrice: tradePrice,
            });
          }
        }

        // Transfer money to seller (they already gave up their items)
        await db
          .update(accounts)
          .set({
            balance: sql`${accounts.balance} + ${tradePrice * tradeQuantity}`,
            updatedAt: new Date(),
          })
          .where(eq(accounts.agentId, sellOrder.agentId));

        await db.insert(transactions).values({
          id: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          fromAgentId: buyOrder.agentId,
          toAgentId: sellOrder.agentId,
          amount: tradePrice * tradeQuantity,
          type: 'sale',
          description: `Market sale of ${tradeQuantity}x ${itemId}`,
          referenceId: tradeId,
          referenceType: 'market_trade',
        });

        // Refund price difference to buyer if they paid more
        const priceDiff = buyOrder.price - tradePrice;
        if (priceDiff > 0) {
          await db
            .update(accounts)
            .set({
              balance: sql`${accounts.balance} + ${priceDiff * tradeQuantity}`,
              updatedAt: new Date(),
            })
            .where(eq(accounts.agentId, buyOrder.agentId));

          await db.insert(transactions).values({
            id: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            toAgentId: buyOrder.agentId,
            amount: priceDiff * tradeQuantity,
            type: 'refund',
            description: `Market price improvement refund for ${tradeQuantity}x ${itemId}`,
            referenceId: tradeId,
            referenceType: 'market_trade',
          });
        }

        // Update local state for continued matching
        buyOrder.filledQuantity = newBuyFilled;
        sellOrder.filledQuantity = newSellFilled;
      }
    }
  },

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string, agentId: string) {
    const order = await db.query.marketOrders.findFirst({
      where: eq(marketOrders.id, orderId),
    });

    if (!order) throw new Error('Order not found');
    if (order.agentId !== agentId) throw new Error('Not your order');
    if (order.status !== 'open') throw new Error('Order is not open');

    const remainingQuantity = order.quantity - order.filledQuantity;

    // Return reserved assets
    if (order.orderType === 'sell') {
      // Return items
      const existingInv = await db.query.inventory.findFirst({
        where: and(
          eq(inventory.agentId, agentId),
          eq(inventory.itemId, order.itemId)
        ),
      });

      if (existingInv) {
        await db
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} + ${remainingQuantity}` })
          .where(eq(inventory.id, existingInv.id));
      } else {
        const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await db.insert(inventory).values({
          id: invId,
          agentId,
          itemId: order.itemId,
          quantity: remainingQuantity,
        });
      }
    } else {
      // Return funds
      const refund = order.price * remainingQuantity;
      await db
        .update(accounts)
        .set({
          balance: sql`${accounts.balance} + ${refund}`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.agentId, agentId));
    }

    // Mark order as cancelled
    await db
      .update(marketOrders)
      .set({ status: 'cancelled' })
      .where(eq(marketOrders.id, orderId));

    return { success: true };
  },

  /**
   * Expire open orders past expiresAt and return whatever was reserved.
   */
  async expireExpiredOrders(limit = DEFAULT_EXPIRE_ORDER_LIMIT): Promise<ExpiredOrderResult> {
    const now = new Date();
    const expiredOrders = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.status, 'open'),
        lt(marketOrders.expiresAt, now),
      ),
      orderBy: [asc(marketOrders.expiresAt)],
      limit,
    });

    const result: ExpiredOrderResult = {
      expiredCount: 0,
      buyOrderCount: 0,
      sellOrderCount: 0,
      refundedCents: 0,
      returnedItemCount: 0,
    };

    for (const order of expiredOrders) {
      const expired = await db.transaction(async (tx) => {
        const [claimedOrder] = await tx
          .update(marketOrders)
          .set({ status: 'expired' })
          .where(and(
            eq(marketOrders.id, order.id),
            eq(marketOrders.status, 'open'),
            lt(marketOrders.expiresAt, now),
          ))
          .returning();

        if (!claimedOrder) return null;

        const remainingQuantity = claimedOrder.quantity - claimedOrder.filledQuantity;
        if (remainingQuantity <= 0) {
          return {
            orderType: claimedOrder.orderType,
            refundedCents: 0,
            returnedItemCount: 0,
          };
        }

        if (claimedOrder.orderType === 'sell') {
          const [existingInv] = await tx
            .select({ id: inventory.id })
            .from(inventory)
            .where(and(
              eq(inventory.agentId, claimedOrder.agentId),
              eq(inventory.itemId, claimedOrder.itemId),
            ))
            .limit(1);

          if (existingInv) {
            await tx
              .update(inventory)
              .set({ quantity: sql`${inventory.quantity} + ${remainingQuantity}` })
              .where(eq(inventory.id, existingInv.id));
          } else {
            await tx.insert(inventory).values({
              id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              agentId: claimedOrder.agentId,
              itemId: claimedOrder.itemId,
              quantity: remainingQuantity,
            });
          }

          return {
            orderType: claimedOrder.orderType,
            refundedCents: 0,
            returnedItemCount: remainingQuantity,
          };
        }

        const refund = claimedOrder.price * remainingQuantity;
        await tx
          .update(accounts)
          .set({
            balance: sql`${accounts.balance} + ${refund}`,
            updatedAt: now,
          })
          .where(eq(accounts.agentId, claimedOrder.agentId));

        return {
          orderType: claimedOrder.orderType,
          refundedCents: refund,
          returnedItemCount: 0,
        };
      });

      if (!expired) continue;

      result.expiredCount += 1;
      if (expired.orderType === 'buy') {
        result.buyOrderCount += 1;
        result.refundedCents += expired.refundedCents;
      } else {
        result.sellOrderCount += 1;
        result.returnedItemCount += expired.returnedItemCount;
      }
    }

    return result;
  },

  /**
   * Get order book for an item
   */
  async getOrderBook(itemId: string) {
    const buyOrders = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.itemId, itemId),
        eq(marketOrders.orderType, 'buy'),
        eq(marketOrders.status, 'open')
      ),
      orderBy: [desc(marketOrders.price)],
      with: { agent: { columns: { id: true, name: true, avatarEmoji: true } } },
    });

    const sellOrders = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.itemId, itemId),
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open')
      ),
      orderBy: [asc(marketOrders.price)],
      with: { agent: { columns: { id: true, name: true, avatarEmoji: true } } },
    });

    // Get last traded price
    const lastTrade = await db.query.marketTrades.findFirst({
      where: eq(marketTrades.itemId, itemId),
      orderBy: [desc(marketTrades.createdAt)],
    });

    return {
      bids: buyOrders.map(o => ({
        price: o.price,
        quantity: o.quantity - o.filledQuantity,
        agent: o.agent,
      })),
      asks: sellOrders.map(o => ({
        price: o.price,
        quantity: o.quantity - o.filledQuantity,
        agent: o.agent,
      })),
      lastPrice: lastTrade?.price || null,
      spread: sellOrders[0] && buyOrders[0]
        ? sellOrders[0].price - buyOrders[0].price
        : null,
    };
  },

  /**
   * Get price history for an item
   */
  async getPriceHistory(itemId: string, limit: number = 50) {
    return db.query.marketTrades.findMany({
      where: eq(marketTrades.itemId, itemId),
      with: {
        buyer: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
        seller: {
          columns: { id: true, name: true, avatarEmoji: true },
        },
      },
      orderBy: [desc(marketTrades.createdAt)],
      limit,
    });
  },

  /**
   * Get my open orders
   */
  async getMyOrders(agentId: string) {
    return db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.agentId, agentId),
        eq(marketOrders.status, 'open')
      ),
      with: { item: true },
      orderBy: [desc(marketOrders.createdAt)],
    });
  },

  /**
   * Get market summary (all items with prices)
   */
  async getMarketSummary() {
    // Get all tradeable items
    const allItems = await db.query.items.findMany({
      where: and(eq(items.tradeable, true), ne(items.category, 'base_element')),
    });

    // Bulk query: best bids per item
    const bestBids = await db
      .select({
        itemId: marketOrders.itemId,
        bestPrice: sql<number>`max(${marketOrders.price})`.as('best_price'),
      })
      .from(marketOrders)
      .where(
        and(
          eq(marketOrders.orderType, 'buy'),
          eq(marketOrders.status, 'open')
        )
      )
      .groupBy(marketOrders.itemId);

    // Bulk query: best asks per item
    const bestAsks = await db
      .select({
        itemId: marketOrders.itemId,
        bestPrice: sql<number>`min(${marketOrders.price})`.as('best_price'),
      })
      .from(marketOrders)
      .where(
        and(
          eq(marketOrders.orderType, 'sell'),
          eq(marketOrders.status, 'open')
        )
      )
      .groupBy(marketOrders.itemId);

    // Bulk query: last trade price per item (using DISTINCT ON)
    const lastTrades = await db.execute<{ item_id: string; price: number }>(sql`
      SELECT DISTINCT ON (item_id) item_id, price
      FROM market_trades
      ORDER BY item_id, created_at DESC
    `);

    // Bulk query: 24h volume per item
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const volumes = await db
      .select({
        itemId: marketTrades.itemId,
        volume: sql<number>`coalesce(sum(${marketTrades.quantity}), 0)::int`.as('volume'),
      })
      .from(marketTrades)
      .where(sql`${marketTrades.createdAt} > ${oneDayAgo.toISOString()}`)
      .groupBy(marketTrades.itemId);

    // Build lookup maps
    const bidMap = new Map(bestBids.map(b => [b.itemId, b.bestPrice]));
    const askMap = new Map(bestAsks.map(a => [a.itemId, a.bestPrice]));
    const lastTradeMap = new Map((lastTrades as unknown as { item_id: string; price: number }[]).map(t => [t.item_id, t.price]));
    const volumeMap = new Map(volumes.map(v => [v.itemId, v.volume]));

    return allItems.map(item => ({
      item: {
        id: item.id,
        name: item.name,
        emoji: item.emoji,
        category: item.category,
        currentSupply: item.currentSupply,
      },
      bestBid: bidMap.get(item.id) || null,
      bestAsk: askMap.get(item.id) || null,
      lastPrice: lastTradeMap.get(item.id) || (item.category === 'base_element' ? item.basePrice : null),
      volume24h: volumeMap.get(item.id) || 0,
    }));
  },
};
