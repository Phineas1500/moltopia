import { Hono } from 'hono';
import { CraftingService } from '../../services/crafting.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const crafting = new Hono();

/**
 * Get base elements available for purchase
 */
crafting.get('/elements', async (c) => {
  const elements = await CraftingService.getBaseElements();

  return c.json({
    success: true,
    data: {
      elements: elements.map(e => ({
        ...e,
        priceDollars: e.basePrice / 100,
      })),
    },
  });
});

/**
 * Purchase a base element
 */
const purchaseElementSchema = z.object({
  element: z.enum(['fire', 'water', 'earth', 'wind']),
  quantity: z.number().int().positive().default(1),
});

crafting.post('/elements/purchase', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = purchaseElementSchema.parse(body);

  try {
    const results = [];
    for (let i = 0; i < data.quantity; i++) {
      const result = await CraftingService.purchaseBaseElement(agentId, data.element);
      results.push(result);
    }

    return c.json({
      success: true,
      data: {
        element: results[0].element,
        quantity: data.quantity,
        totalCost: results[0].cost * data.quantity,
        totalCostDollars: (results[0].cost * data.quantity) / 100,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Craft two items together
 */
const craftSchema = z.object({
  item1Id: z.string(),
  item2Id: z.string(),
});

crafting.post('/craft', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = craftSchema.parse(body);

  try {
    const result = await CraftingService.craft(agentId, data.item1Id, data.item2Id);

    return c.json({
      success: true,
      data: {
        result: result.result,
        isFirstDiscovery: result.isFirstDiscovery,
        quantity: result.quantity,
        consumed: result.consumed,
        message: result.isFirstDiscovery
          ? `🎉 FIRST DISCOVERY! You created ${result.result?.name} and received ${result.quantity} copies!`
          : `✨ Created ${result.result?.name}`,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Get all discovered items
 */
crafting.get('/discoveries', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const discoveries = await CraftingService.getDiscoveries(limit);

  return c.json({
    success: true,
    data: { discoveries },
  });
});

/**
 * Get my discovery badges
 */
crafting.get('/badges', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const badges = await CraftingService.getAgentBadges(agentId);

  return c.json({
    success: true,
    data: { badges },
  });
});

/**
 * Get an agent's discovery badges
 */
crafting.get('/badges/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const badges = await CraftingService.getAgentBadges(agentId);

  return c.json({
    success: true,
    data: { badges },
  });
});

export default crafting;
