import { db } from '../db/index.js';
import { accounts, inventory, items, marketOrders, marketTrades, transactions } from '../db/schema.js';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { BASE_ELEMENT_PRICE_CENTS, STARTING_BALANCE_CENTS, SYSTEM_AGENT_ID } from '../constants/economy.js';
import { MarketService } from './market.service.js';
import { WorldDemandPricingService } from './world-demand-pricing.service.js';

const CANDIDATE_LIMIT = 200;
const DEFAULT_MAX_ORDERS = 3;
const MAX_UNITS_PER_ORDER = 3;
const MAX_DIRECT_PURCHASE_UNITS_PER_AGENT = 1;
const MIN_SELL_ORDER_AGE_MS = 15 * 60 * 1000;
const TREASURY_SPEND_FRACTION = 0.9;
const LOW_BALANCE_PRIORITY_CENTS = 10000; // $100
const ONLINE_SELLER_SCORE_BONUS = 20;
const PRICE_NUDGE_ABSOLUTE_TOLERANCE_CENTS = 500; // $5
const PRICE_NUDGE_RELATIVE_TOLERANCE = 0.2;

type DemandCandidate = {
  order: typeof marketOrders.$inferSelect & {
    item: typeof items.$inferSelect;
    agent?: {
      status: string;
      account?: { balance: number } | null;
      presence?: unknown | null;
    } | null;
  };
  remainingQuantity: number;
  maxAcceptablePrice: number;
  score: number;
};

type InventoryDemandCandidate = {
  inventoryId: string;
  agentId: string;
  agentName: string;
  item: typeof items.$inferSelect;
  quantityOwned: number;
  priceCents: number;
  balanceCents: number;
  score: number;
};

type RunOptions = {
  maxOrders?: number;
  minOrderAgeMs?: number;
  maxSpendCents?: number;
  reason?: string;
};

type PriceAdjustment = {
  orderId: string;
  agentId: string;
  itemId: string;
  itemName: string;
  oldPriceCents: number;
  newPriceCents: number;
};

export const WorldDemandService = {
  /**
   * Spend a bounded slice of the system treasury on stale crafted-item asks.
   */
  async runOnce(options: RunOptions = {}) {
    const treasuryBalance = await this.getTreasuryBalanceCents();

    if (treasuryBalance < BASE_ELEMENT_PRICE_CENTS) {
      return {
        createdOrders: [],
        spentOrReservedCents: 0,
        skippedReason: 'treasury_too_low',
      };
    }

    const spendableFromTreasury = Math.floor(treasuryBalance * TREASURY_SPEND_FRACTION);
    const spendable = Math.min(spendableFromTreasury, options.maxSpendCents ?? spendableFromTreasury);
    if (spendable <= 0) {
      return {
        createdOrders: [],
        spentOrReservedCents: 0,
        skippedReason: 'nothing_spendable',
      };
    }

    const minOrderAgeMs = options.minOrderAgeMs ?? MIN_SELL_ORDER_AGE_MS;
    const adjustedOrders = await this.nudgeLowBalanceSellOrders(minOrderAgeMs);
    const candidates = await this.getDemandCandidates(minOrderAgeMs);
    const maxOrders = options.maxOrders ?? DEFAULT_MAX_ORDERS;
    const createdOrders: Array<{
      orderId: string | null;
      itemId: string;
      itemName: string;
      priceCents: number;
      quantity: number;
    }> = [];

    let spentOrReservedCents = 0;
    const boughtItemIds = new Set<string>();

    for (const candidate of candidates) {
      if (createdOrders.length >= maxOrders) break;
      if (boughtItemIds.has(candidate.order.itemId)) continue;

      const remainingBudget = spendable - spentOrReservedCents;
      const quantity = Math.min(
        candidate.remainingQuantity,
        Math.floor(remainingBudget / candidate.order.price),
        MAX_UNITS_PER_ORDER,
      );

      if (quantity <= 0) break;

      try {
        const order = await MarketService.placeOrder({
          agentId: SYSTEM_AGENT_ID,
          itemId: candidate.order.itemId,
          orderType: 'buy',
          price: candidate.order.price,
          quantity,
          expiresInHours: 24,
          skipPresence: true,
        });

        createdOrders.push({
          orderId: order?.id ?? null,
          itemId: candidate.order.itemId,
          itemName: candidate.order.item.name,
          priceCents: candidate.order.price,
          quantity,
        });
        spentOrReservedCents += candidate.order.price * quantity;
        boughtItemIds.add(candidate.order.itemId);
      } catch (error) {
        console.error('World demand order failed:', {
          reason: options.reason,
          itemId: candidate.order.itemId,
          price: candidate.order.price,
          quantity,
          error,
        });
      }
    }

    const directPurchases: Array<{
      tradeId: string;
      buyOrderId: string;
      sellOrderId: string;
      agentId: string;
      agentName: string;
      itemId: string;
      itemName: string;
      priceCents: number;
      quantity: number;
    }> = [];
    const directlyPurchasedAgentIds = new Set<string>();

    if (createdOrders.length < maxOrders && spentOrReservedCents < spendable) {
      const inventoryCandidates = await this.getInventoryDemandCandidates();

      for (const candidate of inventoryCandidates) {
        if (createdOrders.length >= maxOrders) break;
        if (directlyPurchasedAgentIds.has(candidate.agentId)) continue;

        const remainingBudget = spendable - spentOrReservedCents;
        const quantity = Math.min(
          candidate.quantityOwned,
          Math.floor(remainingBudget / candidate.priceCents),
          MAX_DIRECT_PURCHASE_UNITS_PER_AGENT,
        );

        if (quantity <= 0) continue;

        try {
          const purchase = await this.purchaseInventoryCandidate(candidate, quantity);
          directPurchases.push(purchase);
          createdOrders.push({
            orderId: purchase.buyOrderId,
            itemId: candidate.item.id,
            itemName: candidate.item.name,
            priceCents: candidate.priceCents,
            quantity,
          });
          spentOrReservedCents += candidate.priceCents * quantity;
          directlyPurchasedAgentIds.add(candidate.agentId);
        } catch (error) {
          console.error('World demand direct inventory purchase failed:', {
            reason: options.reason,
            agentId: candidate.agentId,
            itemId: candidate.item.id,
            price: candidate.priceCents,
            quantity,
            error,
          });
        }
      }
    }

    return {
      createdOrders,
      adjustedOrders,
      directPurchases,
      spentOrReservedCents,
      skippedReason: createdOrders.length === 0 ? 'no_matching_asks' : null,
    };
  },

  async getStats() {
    const [treasury] = await db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.agentId, SYSTEM_AGENT_ID))
      .limit(1);

    const [reservedSystemBids] = await db
      .select({
        total: sql<number>`COALESCE(SUM((${marketOrders.quantity} - ${marketOrders.filledQuantity}) * ${marketOrders.price}), 0)::int`,
      })
      .from(marketOrders)
      .where(and(
        eq(marketOrders.agentId, SYSTEM_AGENT_ID),
        eq(marketOrders.orderType, 'buy'),
        eq(marketOrders.status, 'open'),
      ));

    const [legacyLoggedPurchases] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)::int`,
      })
      .from(transactions)
      .where(sql`${transactions.type} = 'purchase' AND ${transactions.fromAgentId} IS NOT NULL AND ${transactions.toAgentId} IS NULL`);

    const estimatedHistoricalSinkRows = await db.execute<{ estimated_system_sink_cents: number }>(sql`
      SELECT GREATEST(
        (
          SELECT COUNT(*)
          FROM accounts
          WHERE agent_id <> ${SYSTEM_AGENT_ID}
        ) * ${STARTING_BALANCE_CENTS}
        - COALESCE((
          SELECT SUM(balance)
          FROM accounts
          WHERE agent_id <> ${SYSTEM_AGENT_ID}
        ), 0)
        - COALESCE((
          SELECT SUM((quantity - filled_quantity) * price)
          FROM market_orders
          WHERE order_type = 'buy'
            AND status = 'open'
            AND agent_id <> ${SYSTEM_AGENT_ID}
        ), 0)
        - COALESCE((
          SELECT SUM(reward)
          FROM bounties
          WHERE status = 'open'
            AND creator_id <> ${SYSTEM_AGENT_ID}
        ), 0),
        0
      )::int AS estimated_system_sink_cents
    `);

    const [creditedPurchases] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)::int`,
      })
      .from(transactions)
      .where(and(
        eq(transactions.type, 'purchase'),
        eq(transactions.toAgentId, SYSTEM_AGENT_ID),
      ));

    const [worldDemandTrades] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${marketTrades.price} * ${marketTrades.quantity}), 0)::int`,
      })
      .from(marketTrades)
      .where(eq(marketTrades.buyerId, SYSTEM_AGENT_ID));

    const [recoveryWorkPayouts] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)::int`,
      })
      .from(transactions)
      .where(and(
        eq(transactions.fromAgentId, SYSTEM_AGENT_ID),
        eq(transactions.referenceType, 'world_work'),
      ));

    const [openSellOrders] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
      })
      .from(marketOrders)
      .where(and(
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open'),
        ne(marketOrders.agentId, SYSTEM_AGENT_ID),
      ));

    const treasuryBalanceCents = treasury?.balance ?? 0;
    const reservedSystemBidCents = reservedSystemBids?.total ?? 0;
    const exactBackfilledCents = legacyLoggedPurchases?.total ?? 0;
    const estimatedHistoricalSink = (estimatedHistoricalSinkRows as unknown as { estimated_system_sink_cents: number }[])[0];
    const estimatedHistoricalSinkCents = Number(estimatedHistoricalSink?.estimated_system_sink_cents ?? 0);
    const creditedPurchaseCents = creditedPurchases?.total ?? 0;
    const worldDemandTradeCents = worldDemandTrades?.total ?? 0;
    const recoveryWorkPayoutCents = recoveryWorkPayouts?.total ?? 0;
    const recoveredHistoricalSinkCents = Math.max(exactBackfilledCents, estimatedHistoricalSinkCents);

    return {
      systemAgentId: SYSTEM_AGENT_ID,
      treasuryBalanceCents,
      treasuryBalanceDollars: treasuryBalanceCents / 100,
      reservedSystemBidCents,
      reservedSystemBidDollars: reservedSystemBidCents / 100,
      exactBackfilledPurchaseCents: exactBackfilledCents,
      exactBackfilledPurchaseDollars: exactBackfilledCents / 100,
      estimatedHistoricalSinkCents,
      estimatedHistoricalSinkDollars: estimatedHistoricalSinkCents / 100,
      recoveredHistoricalSinkCents,
      recoveredHistoricalSinkDollars: recoveredHistoricalSinkCents / 100,
      creditedPurchaseCents,
      creditedPurchaseDollars: creditedPurchaseCents / 100,
      worldDemandTradeCents,
      worldDemandTradeDollars: worldDemandTradeCents / 100,
      recoveryWorkPayoutCents,
      recoveryWorkPayoutDollars: recoveryWorkPayoutCents / 100,
      openSellOrderCount: openSellOrders?.count ?? 0,
      historicalBaseElementSpendBackfilled: recoveredHistoricalSinkCents > 0,
    };
  },

  async getTreasuryBalanceCents(): Promise<number> {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, SYSTEM_AGENT_ID),
    });

    return account?.balance ?? 0;
  },

  async getDemandCandidates(minOrderAgeMs: number): Promise<DemandCandidate[]> {
    const openSystemBids = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.agentId, SYSTEM_AGENT_ID),
        eq(marketOrders.orderType, 'buy'),
        eq(marketOrders.status, 'open'),
      ),
    });
    const systemBidByItem = new Map<string, number>();
    for (const bid of openSystemBids) {
      const current = systemBidByItem.get(bid.itemId) ?? 0;
      systemBidByItem.set(bid.itemId, Math.max(current, bid.price));
    }

    const openSells = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open'),
        ne(marketOrders.agentId, SYSTEM_AGENT_ID),
      ),
      with: {
        item: true,
        agent: {
          with: {
            account: true,
            presence: true,
          },
        },
      },
      orderBy: [asc(marketOrders.price), asc(marketOrders.createdAt)],
      limit: CANDIDATE_LIMIT,
    });

    const now = Date.now();
    const candidates: DemandCandidate[] = [];
    const costMemo = new Map<string, number>();

    for (const order of openSells) {
      if (!order.item || order.item.category !== 'crafted') continue;
      if (order.agent?.status === 'banned') continue;

      const remainingQuantity = order.quantity - order.filledQuantity;
      if (remainingQuantity <= 0) continue;

      const sellerBalance = order.agent?.account?.balance ?? STARTING_BALANCE_CENTS;
      const lowBalanceSeller = sellerBalance < LOW_BALANCE_PRIORITY_CENTS;
      const ageMs = now - order.createdAt.getTime();
      if (!lowBalanceSeller && ageMs < minOrderAgeMs) continue;

      const existingSystemBid = systemBidByItem.get(order.itemId) ?? 0;
      if (existingSystemBid >= order.price) continue;

      const maxAcceptablePrice = await this.getMaxAcceptablePriceCents(order.item, costMemo);

      if (order.price > maxAcceptablePrice) continue;

      const ageScore = Math.min(ageMs / (60 * 60 * 1000), 48);
      const scarcityScore = Math.max(0, 20 - order.item.currentSupply);
      const valueScore = maxAcceptablePrice / order.price;
      const lowBalanceSellerScore = Math.min(
        40,
        Math.max(0, (LOW_BALANCE_PRIORITY_CENTS - sellerBalance) / 250),
      );
      const onlineSellerScore = order.agent?.presence ? ONLINE_SELLER_SCORE_BONUS : 0;

      candidates.push({
        order,
        remainingQuantity,
        maxAcceptablePrice,
        score: ageScore + scarcityScore * 0.5 + valueScore * 3 + lowBalanceSellerScore + onlineSellerScore,
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.order.price - b.order.price);
    return candidates;
  },

  async getInventoryDemandCandidates(): Promise<InventoryDemandCandidate[]> {
    const openSells = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open'),
        ne(marketOrders.agentId, SYSTEM_AGENT_ID),
      ),
      columns: {
        agentId: true,
      },
    });
    const agentsWithOpenSells = new Set(openSells.map(order => order.agentId));

    const inventoryRows = await db.query.inventory.findMany({
      where: sql`${inventory.quantity} > 0`,
      with: {
        item: true,
        agent: {
          with: {
            account: true,
            presence: true,
          },
        },
      },
      limit: CANDIDATE_LIMIT,
    });

    const memo = new Map<string, number>();
    const candidates: InventoryDemandCandidate[] = [];

    for (const row of inventoryRows) {
      if (!row.item || row.item.category !== 'crafted') continue;
      if (!row.agent || row.agent.status !== 'active') continue;
      if (!row.agent.presence) continue;
      if (agentsWithOpenSells.has(row.agentId)) continue;

      const balanceCents = row.agent.account?.balance ?? STARTING_BALANCE_CENTS;
      if (balanceCents >= LOW_BALANCE_PRIORITY_CENTS) continue;

      const priceCents = await this.getMaxAcceptablePriceCents(row.item, memo);
      const scarcityScore = Math.max(0, 20 - row.item.currentSupply);
      const lowBalanceScore = Math.min(
        40,
        Math.max(0, (LOW_BALANCE_PRIORITY_CENTS - balanceCents) / 250),
      );

      candidates.push({
        inventoryId: row.id,
        agentId: row.agentId,
        agentName: row.agent.name,
        item: row.item,
        quantityOwned: row.quantity,
        priceCents,
        balanceCents,
        score: lowBalanceScore + scarcityScore * 0.5 + priceCents / BASE_ELEMENT_PRICE_CENTS,
      });
    }

    candidates.sort((a, b) => (
      b.score - a.score
      || a.balanceCents - b.balanceCents
      || a.priceCents - b.priceCents
    ));
    return candidates;
  },

  async purchaseInventoryCandidate(candidate: InventoryDemandCandidate, quantity: number) {
    const now = new Date();
    const buyOrderId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sellOrderId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const amount = candidate.priceCents * quantity;
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    return db.transaction(async (tx) => {
      const [currentInventory] = await tx
        .select({ quantity: inventory.quantity })
        .from(inventory)
        .where(and(
          eq(inventory.id, candidate.inventoryId),
          eq(inventory.agentId, candidate.agentId),
          eq(inventory.itemId, candidate.item.id),
        ))
        .limit(1);

      if (!currentInventory || currentInventory.quantity < quantity) {
        throw new Error(`Insufficient inventory for treasury purchase. Have ${currentInventory?.quantity ?? 0}, need ${quantity}.`);
      }

      const [sellerAccount] = await tx
        .select({ balance: accounts.balance })
        .from(accounts)
        .where(eq(accounts.agentId, candidate.agentId))
        .limit(1);

      if (!sellerAccount || sellerAccount.balance >= LOW_BALANCE_PRIORITY_CENTS) {
        throw new Error('Seller is no longer eligible for low-balance treasury procurement.');
      }

      const [treasuryDebit] = await tx
        .update(accounts)
        .set({
          balance: sql`${accounts.balance} - ${amount}`,
          updatedAt: now,
        })
        .where(and(
          eq(accounts.agentId, SYSTEM_AGENT_ID),
          sql`${accounts.balance} >= ${amount}`,
        ))
        .returning({ balance: accounts.balance });

      if (!treasuryDebit) {
        throw new Error('World Treasury does not have enough funds for inventory procurement right now.');
      }

      await tx
        .update(accounts)
        .set({
          balance: sql`${accounts.balance} + ${amount}`,
          updatedAt: now,
        })
        .where(eq(accounts.agentId, candidate.agentId));

      if (currentInventory.quantity === quantity) {
        await tx.delete(inventory).where(eq(inventory.id, candidate.inventoryId));
      } else {
        await tx
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} - ${quantity}` })
          .where(eq(inventory.id, candidate.inventoryId));
      }

      await tx
        .update(items)
        .set({ currentSupply: sql`GREATEST(${items.currentSupply} - ${quantity}, 0)` })
        .where(eq(items.id, candidate.item.id));

      await tx.insert(marketOrders).values([
        {
          id: buyOrderId,
          agentId: SYSTEM_AGENT_ID,
          itemId: candidate.item.id,
          orderType: 'buy',
          price: candidate.priceCents,
          quantity,
          filledQuantity: quantity,
          status: 'filled',
          expiresAt,
          createdAt: now,
        },
        {
          id: sellOrderId,
          agentId: candidate.agentId,
          itemId: candidate.item.id,
          orderType: 'sell',
          price: candidate.priceCents,
          quantity,
          filledQuantity: quantity,
          status: 'filled',
          expiresAt,
          createdAt: now,
        },
      ]);

      await tx.insert(marketTrades).values({
        id: tradeId,
        itemId: candidate.item.id,
        buyerId: SYSTEM_AGENT_ID,
        sellerId: candidate.agentId,
        price: candidate.priceCents,
        quantity,
        buyOrderId,
        sellOrderId,
        createdAt: now,
      });

      await tx.insert(transactions).values({
        id: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        fromAgentId: SYSTEM_AGENT_ID,
        toAgentId: candidate.agentId,
        amount,
        type: 'sale',
        description: `World Treasury inventory procurement of ${quantity}x ${candidate.item.id}`,
        referenceId: tradeId,
        referenceType: 'market_trade',
        createdAt: now,
      });

      return {
        tradeId,
        buyOrderId,
        sellOrderId,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        itemId: candidate.item.id,
        itemName: candidate.item.name,
        priceCents: candidate.priceCents,
        quantity,
      };
    });
  },

  async getPricingGuidance(itemId: string, memo = new Map<string, number>()) {
    return WorldDemandPricingService.getPricingGuidance(itemId, memo);
  },

  async nudgeLowBalanceSellOrders(minOrderAgeMs = MIN_SELL_ORDER_AGE_MS): Promise<PriceAdjustment[]> {
    const openSells = await db.query.marketOrders.findMany({
      where: and(
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open'),
        ne(marketOrders.agentId, SYSTEM_AGENT_ID),
      ),
      with: {
        item: true,
        agent: {
          with: {
            account: true,
          },
        },
      },
      orderBy: [asc(marketOrders.createdAt)],
      limit: CANDIDATE_LIMIT,
    });

    const now = Date.now();
    const memo = new Map<string, number>();
    const adjusted: PriceAdjustment[] = [];

    for (const order of openSells) {
      if (!order.item || order.item.category !== 'crafted') continue;
      if (order.agent?.status === 'banned') continue;
      if ((order.quantity - order.filledQuantity) <= 0) continue;
      if ((order.agent?.account?.balance ?? STARTING_BALANCE_CENTS) >= LOW_BALANCE_PRIORITY_CENTS) continue;
      if (now - order.createdAt.getTime() < minOrderAgeMs) continue;

      const maxAcceptablePrice = await this.getMaxAcceptablePriceCents(order.item, memo);
      if (order.price <= maxAcceptablePrice) continue;

      const tolerance = Math.max(
        PRICE_NUDGE_ABSOLUTE_TOLERANCE_CENTS,
        Math.round(maxAcceptablePrice * PRICE_NUDGE_RELATIVE_TOLERANCE),
      );
      if (order.price > maxAcceptablePrice + tolerance) continue;

      await db
        .update(marketOrders)
        .set({ price: maxAcceptablePrice })
        .where(eq(marketOrders.id, order.id));

      adjusted.push({
        orderId: order.id,
        agentId: order.agentId,
        itemId: order.itemId,
        itemName: order.item.name,
        oldPriceCents: order.price,
        newPriceCents: maxAcceptablePrice,
      });
    }

    return adjusted;
  },

  async getMaxAcceptablePriceCents(
    item: typeof items.$inferSelect,
    memo = new Map<string, number>(),
  ): Promise<number> {
    return WorldDemandPricingService.getMaxAcceptablePriceCents(item, memo);
  },

  async estimateCraftCostCents(
    itemId: string,
    memo = new Map<string, number>(),
    seen = new Set<string>(),
  ): Promise<number> {
    return WorldDemandPricingService.estimateCraftCostCents(itemId, memo, seen);
  },
};
