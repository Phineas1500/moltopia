import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, agents, inventory, items, marketOrders } from '../db/schema.js';
import { RECOVERY_WORK_TARGET_BALANCE_CENTS, SYSTEM_AGENT_ID } from '../constants/economy.js';
import { WorldDemandPricingService } from './world-demand-pricing.service.js';

const MIN_BUY_OPPORTUNITY_BALANCE_CENTS = RECOVERY_WORK_TARGET_BALANCE_CENTS * 2;
const MIN_SUPPORT_BID_BALANCE_CENTS = RECOVERY_WORK_TARGET_BALANCE_CENTS * 5;
const MAX_BUY_OPPORTUNITY_SPEND_CENTS = 10000; // $100
const LOW_BALANCE_SELLER_CENTS = RECOVERY_WORK_TARGET_BALANCE_CENTS * 5;
const CANDIDATE_LIMIT = 200;

export interface MarketBuyOpportunity {
  orderId: string | null;
  opportunityType: 'listed_item' | 'support_bid';
  item: {
    id: string;
    name: string;
    emoji: string | null;
    category: string;
    currentSupply: number;
  };
  seller: {
    id: string;
    name: string;
    avatarEmoji: string | null;
  };
  sellerBalanceCents: number | null;
  sellerBalanceDollars: number | null;
  priceCents: number;
  priceDollars: number;
  remainingQuantity: number;
  createdAt: Date | null;
  reason: string;
}

export interface MarketSellOpportunity {
  item: {
    id: string;
    name: string;
    emoji: string | null;
    category: string;
    currentSupply: number;
  };
  quantityOwned: number;
  bestBidCents: number | null;
  bestBidDollars: number | null;
  treasuryMaxBuyCents: number | null;
  treasuryMaxBuyDollars: number | null;
  suggestedSellPriceCents: number;
  suggestedSellPriceDollars: number;
  reason: string;
}

export function buyOpportunitySpendLimitCents(balanceCents: number) {
  if (balanceCents < MIN_BUY_OPPORTUNITY_BALANCE_CENTS) return 0;

  const protectedReserve = balanceCents - RECOVERY_WORK_TARGET_BALANCE_CENTS;
  const proportionalBudget = Math.floor(balanceCents * 0.25);
  const minimumUsefulBudget = RECOVERY_WORK_TARGET_BALANCE_CENTS;

  return Math.max(
    0,
    Math.min(
      protectedReserve,
      Math.max(minimumUsefulBudget, proportionalBudget),
      MAX_BUY_OPPORTUNITY_SPEND_CENTS,
    ),
  );
}

export const MarketOpportunityService = {
  async getBuyOpportunities(
    agentId: string,
    maxResults = 5,
    knownBalanceCents?: number,
  ): Promise<MarketBuyOpportunity[]> {
    const balanceCents = knownBalanceCents === undefined
      ? await db.query.accounts.findFirst({
        where: eq(accounts.agentId, agentId),
      }).then(account => account?.balance ?? 0)
      : knownBalanceCents;

    const maxPriceCents = buyOpportunitySpendLimitCents(balanceCents);
    if (maxPriceCents <= 0) return [];

    const rows = await db
      .select({
        orderId: marketOrders.id,
        itemId: items.id,
        itemName: items.name,
        itemEmoji: items.emoji,
        itemCategory: items.category,
        itemCurrentSupply: items.currentSupply,
        sellerId: agents.id,
        sellerName: agents.name,
        sellerAvatarEmoji: agents.avatarEmoji,
        sellerBalanceCents: accounts.balance,
        priceCents: marketOrders.price,
        remainingQuantity: sql<number>`(${marketOrders.quantity} - ${marketOrders.filledQuantity})::int`,
        createdAt: marketOrders.createdAt,
      })
      .from(marketOrders)
      .innerJoin(items, eq(marketOrders.itemId, items.id))
      .innerJoin(agents, eq(marketOrders.agentId, agents.id))
      .innerJoin(accounts, eq(accounts.agentId, agents.id))
      .where(and(
        eq(marketOrders.orderType, 'sell'),
        eq(marketOrders.status, 'open'),
        ne(marketOrders.agentId, agentId),
        ne(marketOrders.agentId, SYSTEM_AGENT_ID),
        ne(agents.status, 'banned'),
        eq(items.tradeable, true),
        ne(items.category, 'base_element'),
        sql`${marketOrders.quantity} > ${marketOrders.filledQuantity}`,
        sql`${marketOrders.price} <= ${maxPriceCents}`,
      ))
      .orderBy(asc(accounts.balance), asc(marketOrders.price), asc(items.currentSupply), asc(marketOrders.createdAt))
      .limit(Math.max(maxResults * 5, maxResults));

    const opportunities: MarketBuyOpportunity[] = [];
    const seen = new Map<string, MarketBuyOpportunity>();

    for (const row of rows) {
      const key = `${row.itemId}:${row.sellerId}:${row.priceCents}`;
      const existing = seen.get(key);
      if (existing) {
        existing.remainingQuantity += row.remainingQuantity;
        continue;
      }

      const opportunity = {
        orderId: row.orderId,
        opportunityType: 'listed_item' as const,
        item: {
          id: row.itemId,
          name: row.itemName,
          emoji: row.itemEmoji,
          category: row.itemCategory,
          currentSupply: row.itemCurrentSupply,
        },
        seller: {
          id: row.sellerId,
          name: row.sellerName,
          avatarEmoji: row.sellerAvatarEmoji,
        },
        sellerBalanceCents: row.sellerBalanceCents,
        sellerBalanceDollars: row.sellerBalanceCents / 100,
        priceCents: row.priceCents,
        priceDollars: row.priceCents / 100,
        remainingQuantity: row.remainingQuantity,
        createdAt: row.createdAt,
        reason: row.sellerBalanceCents < LOW_BALANCE_SELLER_CENTS
          ? `${row.sellerName}'s balance is $${(row.sellerBalanceCents / 100).toFixed(2)}; buying their listing moves cash to a low-balance seller and gives you an ingredient for crafting or resale.`
          : 'Affordable listed item from another agent; buying it moves cash to a seller and gives you an ingredient for crafting or resale.',
      };

      seen.set(key, opportunity);
      opportunities.push(opportunity);
      if (opportunities.length >= maxResults) break;
    }

    if (opportunities.length < maxResults && balanceCents >= MIN_SUPPORT_BID_BALANCE_CENTS) {
      const supportBids = await this.getSupportBidOpportunities(
        agentId,
        maxResults - opportunities.length,
        maxPriceCents,
      );
      opportunities.push(...supportBids);
    }

    return opportunities;
  },

  async getSupportBidOpportunities(
    agentId: string,
    maxResults = 5,
    maxPriceCents?: number,
  ): Promise<MarketBuyOpportunity[]> {
    const spendLimitCents: number = maxPriceCents !== undefined
      ? maxPriceCents
      : await db.query.accounts.findFirst({
        where: eq(accounts.agentId, agentId),
      }).then(account => buyOpportunitySpendLimitCents(account?.balance ?? 0));

    if (spendLimitCents <= 0) return [];

    const [existingBuyerBids, bestAgentBids, openSellRows, inventoryRows] = await Promise.all([
      db.query.marketOrders.findMany({
        where: and(
          eq(marketOrders.agentId, agentId),
          eq(marketOrders.orderType, 'buy'),
          eq(marketOrders.status, 'open'),
        ),
        columns: {
          itemId: true,
          price: true,
        },
      }),
      db
        .select({
          itemId: marketOrders.itemId,
          priceCents: sql<number>`MAX(${marketOrders.price})::int`,
        })
        .from(marketOrders)
        .where(and(
          eq(marketOrders.orderType, 'buy'),
          eq(marketOrders.status, 'open'),
          ne(marketOrders.agentId, SYSTEM_AGENT_ID),
        ))
        .groupBy(marketOrders.itemId),
      db.query.marketOrders.findMany({
        where: and(
          eq(marketOrders.orderType, 'sell'),
          eq(marketOrders.status, 'open'),
        ),
        columns: {
          agentId: true,
          itemId: true,
        },
      }),
      db.query.inventory.findMany({
        where: and(
          ne(inventory.agentId, agentId),
          sql`${inventory.quantity} > 0`,
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
        limit: CANDIDATE_LIMIT,
      }),
    ]);

    const buyerBidByItem = new Map<string, number>();
    for (const bid of existingBuyerBids) {
      buyerBidByItem.set(bid.itemId, Math.max(buyerBidByItem.get(bid.itemId) ?? 0, bid.price));
    }

    const bestAgentBidByItem = new Map(bestAgentBids.map(bid => [bid.itemId, bid.priceCents ?? 0]));
    const openSellByAgentItem = new Set(openSellRows.map(order => `${order.agentId}:${order.itemId}`));
    const memo = new Map<string, number>();
    const candidates: MarketBuyOpportunity[] = [];

    for (const row of inventoryRows) {
      if (!row.item || row.item.category !== 'crafted' || !row.item.tradeable) continue;
      if (!row.agent || row.agent.status !== 'active' || !row.agent.presence) continue;

      const sellerBalanceCents = row.agent.account?.balance ?? 0;
      if (sellerBalanceCents >= LOW_BALANCE_SELLER_CENTS) continue;
      if (openSellByAgentItem.has(`${row.agentId}:${row.itemId}`)) continue;

      const guidance = await WorldDemandPricingService.getPricingGuidance(row.itemId, memo);
      const priceCents = guidance.suggestedSellPriceCents ?? 0;
      if (priceCents <= 0 || priceCents > spendLimitCents) continue;

      if ((buyerBidByItem.get(row.itemId) ?? 0) >= priceCents) continue;
      if ((bestAgentBidByItem.get(row.itemId) ?? 0) >= priceCents) continue;

      candidates.push({
        orderId: null,
        opportunityType: 'support_bid',
        item: {
          id: row.item.id,
          name: row.item.name,
          emoji: row.item.emoji,
          category: row.item.category,
          currentSupply: row.item.currentSupply,
        },
        seller: {
          id: row.agentId,
          name: row.agent.name,
          avatarEmoji: row.agent.avatarEmoji,
        },
        sellerBalanceCents,
        sellerBalanceDollars: sellerBalanceCents / 100,
        priceCents,
        priceDollars: priceCents / 100,
        remainingQuantity: row.quantity,
        createdAt: null,
        reason: `${row.agent.name}'s balance is $${(sellerBalanceCents / 100).toFixed(2)} and they hold ${row.item.name}. Posting a buy order creates real agent demand they can sell into, moving your cash to a poorer agent without minting money.`,
      });
    }

    return candidates
      .sort((a, b) => (
        (a.sellerBalanceCents ?? 0) - (b.sellerBalanceCents ?? 0)
        || a.priceCents - b.priceCents
        || a.item.currentSupply - b.item.currentSupply
      ))
      .slice(0, maxResults);
  },

  async getSellOpportunities(agentId: string, maxResults = 5): Promise<MarketSellOpportunity[]> {
    const inventoryRows = await db
      .select({
        itemId: items.id,
        itemName: items.name,
        itemEmoji: items.emoji,
        itemCategory: items.category,
        itemCurrentSupply: items.currentSupply,
        quantityOwned: inventory.quantity,
      })
      .from(inventory)
      .innerJoin(items, eq(inventory.itemId, items.id))
      .where(and(
        eq(inventory.agentId, agentId),
        eq(items.tradeable, true),
        eq(items.category, 'crafted'),
        sql`${inventory.quantity} > 0`,
      ))
      .limit(Math.max(maxResults * 2, maxResults));

    const memo = new Map<string, number>();
    const opportunities: MarketSellOpportunity[] = [];

    for (const row of inventoryRows) {
      const [bestBid] = await db
        .select({
          priceCents: sql<number>`MAX(${marketOrders.price})::int`,
        })
        .from(marketOrders)
        .where(and(
          eq(marketOrders.itemId, row.itemId),
          eq(marketOrders.orderType, 'buy'),
          eq(marketOrders.status, 'open'),
          ne(marketOrders.agentId, agentId),
        ));

      const guidance = await WorldDemandPricingService.getPricingGuidance(row.itemId, memo);
      const bestBidCents = bestBid?.priceCents ?? null;
      const suggestedSellPriceCents = Math.max(bestBidCents ?? 0, guidance.suggestedSellPriceCents ?? 0);
      if (suggestedSellPriceCents <= 0) continue;

      opportunities.push({
        item: {
          id: row.itemId,
          name: row.itemName,
          emoji: row.itemEmoji,
          category: row.itemCategory,
          currentSupply: row.itemCurrentSupply,
        },
        quantityOwned: row.quantityOwned,
        bestBidCents,
        bestBidDollars: bestBidCents ? bestBidCents / 100 : null,
        treasuryMaxBuyCents: guidance.treasuryMaxBuyCents,
        treasuryMaxBuyDollars: guidance.treasuryMaxBuyDollars,
        suggestedSellPriceCents,
        suggestedSellPriceDollars: suggestedSellPriceCents / 100,
        reason: bestBidCents && bestBidCents >= suggestedSellPriceCents
          ? 'There is an open bid at this price; selling here should fill immediately.'
          : 'This price is eligible for World Treasury demand if the order waits on the market.',
      });
    }

    return opportunities
      .sort((a, b) => b.suggestedSellPriceCents - a.suggestedSellPriceCents || a.item.name.localeCompare(b.item.name))
      .slice(0, maxResults);
  },
};
