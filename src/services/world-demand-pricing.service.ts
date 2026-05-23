import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { items } from '../db/schema.js';
import { BASE_ELEMENT_PRICE_CENTS } from '../constants/economy.js';

const MAX_UNIT_PRICE_CENTS = 25000; // $250

export const WorldDemandPricingService = {
  async getPricingGuidance(itemId: string, memo = new Map<string, number>()) {
    const item = await db.query.items.findFirst({
      where: eq(items.id, itemId),
    });

    if (!item || item.category !== 'crafted') {
      return {
        itemId,
        treasuryMaxBuyCents: null,
        treasuryMaxBuyDollars: null,
        suggestedSellPriceCents: null,
        suggestedSellPriceDollars: null,
      };
    }

    const treasuryMaxBuyCents = await this.getMaxAcceptablePriceCents(item, memo);

    return {
      itemId,
      treasuryMaxBuyCents,
      treasuryMaxBuyDollars: treasuryMaxBuyCents / 100,
      suggestedSellPriceCents: treasuryMaxBuyCents,
      suggestedSellPriceDollars: treasuryMaxBuyCents / 100,
    };
  },

  async getMaxAcceptablePriceCents(
    item: typeof items.$inferSelect,
    memo = new Map<string, number>(),
  ): Promise<number> {
    const estimatedCost = await this.estimateCraftCostCents(item.id, memo);
    const rarityPremium = item.currentSupply <= 3
      ? 1.8
      : item.currentSupply <= 10
        ? 1.5
        : 1.25;

    return Math.min(
      MAX_UNIT_PRICE_CENTS,
      Math.max(BASE_ELEMENT_PRICE_CENTS * 2, Math.round(estimatedCost * rarityPremium)),
    );
  },

  async estimateCraftCostCents(
    itemId: string,
    memo = new Map<string, number>(),
    seen = new Set<string>(),
  ): Promise<number> {
    const cached = memo.get(itemId);
    if (cached !== undefined) return cached;

    if (seen.has(itemId)) return BASE_ELEMENT_PRICE_CENTS * 2;
    seen.add(itemId);

    const item = await db.query.items.findFirst({
      where: eq(items.id, itemId),
    });

    if (!item) return BASE_ELEMENT_PRICE_CENTS * 2;

    if (item.category === 'base_element') {
      memo.set(itemId, item.basePrice || BASE_ELEMENT_PRICE_CENTS);
      return item.basePrice || BASE_ELEMENT_PRICE_CENTS;
    }

    if (item.category !== 'crafted') {
      const basePrice = Math.max(item.basePrice, BASE_ELEMENT_PRICE_CENTS);
      memo.set(itemId, basePrice);
      return basePrice;
    }

    const recipe = item.recipe as { ingredient1?: string; ingredient2?: string } | null;
    if (!recipe?.ingredient1 || !recipe?.ingredient2) {
      const fallback = Math.max(item.basePrice, BASE_ELEMENT_PRICE_CENTS * 2);
      memo.set(itemId, fallback);
      return fallback;
    }

    const ingredient1Cost = await this.estimateCraftCostCents(recipe.ingredient1, memo, new Set(seen));
    const ingredient2Cost = await this.estimateCraftCostCents(recipe.ingredient2, memo, new Set(seen));
    const cost = ingredient1Cost + ingredient2Cost;

    memo.set(itemId, cost);
    return cost;
  },
};
