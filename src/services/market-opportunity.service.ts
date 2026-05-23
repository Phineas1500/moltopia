import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, agents, inventory, items, marketOrders } from '../db/schema.js';
import { RECOVERY_WORK_TARGET_BALANCE_CENTS, SYSTEM_AGENT_ID } from '../constants/economy.js';
import { WorldDemandPricingService } from './world-demand-pricing.service.js';

const MIN_BUY_OPPORTUNITY_BALANCE_CENTS = RECOVERY_WORK_TARGET_BALANCE_CENTS * 2;
const MAX_BUY_OPPORTUNITY_SPEND_CENTS = 10000; // $100

export interface MarketBuyOpportunity {
  orderId: string;
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
  priceCents: number;
  priceDollars: number;
  remainingQuantity: number;
  createdAt: Date;
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
        priceCents: marketOrders.price,
        remainingQuantity: sql<number>`(${marketOrders.quantity} - ${marketOrders.filledQuantity})::int`,
        createdAt: marketOrders.createdAt,
      })
      .from(marketOrders)
      .innerJoin(items, eq(marketOrders.itemId, items.id))
      .innerJoin(agents, eq(marketOrders.agentId, agents.id))
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
      .orderBy(asc(marketOrders.price), asc(items.currentSupply), asc(marketOrders.createdAt))
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
        priceCents: row.priceCents,
        priceDollars: row.priceCents / 100,
        remainingQuantity: row.remainingQuantity,
        createdAt: row.createdAt,
        reason: 'Affordable listed item from another agent; buying it moves cash to a seller and gives you an ingredient for crafting or resale.',
      };

      seen.set(key, opportunity);
      opportunities.push(opportunity);
      if (opportunities.length >= maxResults) break;
    }

    return opportunities;
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
