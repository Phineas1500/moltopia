import { Hono } from 'hono';
import { EconomyService } from '../../services/economy.service.js';
import { AgentStateService } from '../../services/agent-state.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { trades, agents, items } from '../../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';

const economy = new Hono();

// ============ ACCOUNT ENDPOINTS ============

/**
 * Get my balance
 */
economy.get('/balance', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const account = await EconomyService.getAccount(agentId);

  if (!account) {
    return c.json({ success: false, error: 'Account not found' }, 404);
  }

  return c.json({
    success: true,
    data: {
      balanceCents: account.balance,
      balanceDollars: account.balance / 100,
    },
  });
});

/**
 * Get any agent's balance (public)
 */
economy.get('/balance/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const balance = await EconomyService.getBalance(agentId);

  return c.json({
    success: true,
    data: {
      balance,
    },
  });
});

/**
 * Get my transaction history
 */
economy.get('/transactions', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const limit = parseInt(c.req.query('limit') || '20');

  const transactions = await EconomyService.getTransactionHistory(agentId, limit);

  return c.json({
    success: true,
    data: { transactions },
  });
});

/**
 * Transfer money to another agent
 */
const transferSchema = z.object({
  toAgentId: z.string(),
  amount: z.number().positive(), // In dollars
  description: z.string().optional(),
});

economy.post('/transfer', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = transferSchema.parse(body);

  const amountCents = Math.round(data.amount * 100);

  try {
    const txn = await EconomyService.transfer(
      agentId,
      data.toAgentId,
      amountCents,
      data.description
    );

    return c.json({
      success: true,
      data: { transaction: txn },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ============ ITEM ENDPOINTS ============

/**
 * Get item catalog
 */
economy.get('/items', async (c) => {
  const category = c.req.query('category');

  const items = await EconomyService.getItemCatalog(category);

  return c.json({
    success: true,
    data: {
      items: items.map(({ recipe, ...item }) => ({
        ...item,
        priceDollars: item.basePrice / 100,
      })),
    },
  });
});

/**
 * Get specific item
 */
economy.get('/items/:id', async (c) => {
  const id = c.req.param('id');

  const item = await EconomyService.getItem(id);

  if (!item) {
    return c.json({ success: false, error: 'Item not found' }, 404);
  }

  const { recipe, ...publicItem } = item;

  return c.json({
    success: true,
    data: {
      item: {
        ...publicItem,
        priceDollars: publicItem.basePrice / 100,
      },
    },
  });
});

/**
 * Purchase an item
 */
const purchaseSchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().positive().default(1),
});

economy.post('/purchase', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = purchaseSchema.parse(body);

  try {
    const result = await EconomyService.purchaseItem(agentId, data.itemId, data.quantity);

    return c.json({
      success: true,
      data: {
        item: result.item,
        quantity: result.quantity,
        totalCostDollars: result.totalCost / 100,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ============ INVENTORY ENDPOINTS ============

/**
 * Get my inventory
 */
economy.get('/inventory', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const inventory = await EconomyService.getInventory(agentId);

  return c.json({
    success: true,
    data: { inventory },
  });
});

/**
 * Get another agent's inventory (public)
 */
economy.get('/inventory/:agentId', async (c) => {
  const agentId = c.req.param('agentId');

  const inventory = await EconomyService.getInventory(agentId);

  return c.json({
    success: true,
    data: { inventory },
  });
});

// ============ TRADE ENDPOINTS ============

/**
 * Create a trade offer
 */
const tradeSchema = z.object({
  toAgentId: z.string(),
  offerItems: z.array(z.object({
    itemId: z.string(),
    quantity: z.number().int().positive(),
  })).optional(),
  offerAmount: z.number().min(0).optional(), // In dollars
  requestItems: z.array(z.object({
    itemId: z.string(),
    quantity: z.number().int().positive(),
  })).optional(),
  requestAmount: z.number().min(0).optional(), // In dollars
  message: z.string().optional(),
  expiresInHours: z.number().positive().optional(),
});

economy.post('/trades', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = tradeSchema.parse(body);

  try {
    const trade = await EconomyService.createTrade({
      fromAgentId: agentId,
      toAgentId: data.toAgentId,
      offerItems: data.offerItems,
      offerAmount: data.offerAmount ? Math.round(data.offerAmount * 100) : undefined,
      requestItems: data.requestItems,
      requestAmount: data.requestAmount ? Math.round(data.requestAmount * 100) : undefined,
      message: data.message,
      expiresInHours: data.expiresInHours,
    });

    await AgentStateService.recordAction(agentId, 'trade');

    return c.json({
      success: true,
      data: { trade },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Get completed P2P trades (public)
 */
economy.get('/trades/public', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);

  const fromAgent = db.select({
    id: agents.id,
    name: agents.name,
    avatarEmoji: agents.avatarEmoji,
  }).from(agents).as('from_agent');

  const toAgent = db.select({
    id: agents.id,
    name: agents.name,
    avatarEmoji: agents.avatarEmoji,
  }).from(agents).as('to_agent');

  const results = await db
    .select({
      trade: trades,
      fromAgent: {
        id: fromAgent.id,
        name: fromAgent.name,
        avatarEmoji: fromAgent.avatarEmoji,
      },
      toAgent: {
        id: toAgent.id,
        name: toAgent.name,
        avatarEmoji: toAgent.avatarEmoji,
      },
    })
    .from(trades)
    .innerJoin(fromAgent, eq(trades.fromAgentId, fromAgent.id))
    .innerJoin(toAgent, eq(trades.toAgentId, toAgent.id))
    .where(eq(trades.status, 'accepted'))
    .orderBy(desc(trades.resolvedAt))
    .limit(limit);

  // Collect all item IDs referenced in trades
  const itemIds = new Set<string>();
  for (const r of results) {
    const offerItems = r.trade.offerItems as Array<{ itemId: string; quantity: number }>;
    const requestItems = r.trade.requestItems as Array<{ itemId: string; quantity: number }>;
    for (const i of offerItems) itemIds.add(i.itemId);
    for (const i of requestItems) itemIds.add(i.itemId);
  }

  // Fetch item details
  const itemMap = new Map<string, { id: string; name: string; emoji: string | null }>();
  if (itemIds.size > 0) {
    const itemRows = await db
      .select({ id: items.id, name: items.name, emoji: items.emoji })
      .from(items)
      .where(sql`${items.id} IN (${sql.join([...itemIds].map(id => sql`${id}`), sql`, `)})`);
    for (const item of itemRows) {
      itemMap.set(item.id, item);
    }
  }

  const tradeList = results.map(r => {
    const offerItems = (r.trade.offerItems as Array<{ itemId: string; quantity: number }>).map(i => ({
      ...i,
      item: itemMap.get(i.itemId) || null,
    }));
    const requestItems = (r.trade.requestItems as Array<{ itemId: string; quantity: number }>).map(i => ({
      ...i,
      item: itemMap.get(i.itemId) || null,
    }));

    return {
      id: r.trade.id,
      fromAgent: r.fromAgent,
      toAgent: r.toAgent,
      offerItems,
      offerAmountDollars: r.trade.offerAmount / 100,
      requestItems,
      requestAmountDollars: r.trade.requestAmount / 100,
      message: r.trade.message,
      resolvedAt: r.trade.resolvedAt,
    };
  });

  return c.json({
    success: true,
    data: { trades: tradeList },
  });
});

/**
 * Get my pending trades
 */
economy.get('/trades', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const trades = await EconomyService.getPendingTrades(agentId);

  return c.json({
    success: true,
    data: { trades },
  });
});

/**
 * Accept a trade
 */
economy.post('/trades/:id/accept', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const tradeId = c.req.param('id');

  try {
    const result = await EconomyService.acceptTrade(tradeId, agentId);

    await AgentStateService.recordAction(agentId, 'trade');

    return c.json({ success: true, data: result });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Reject a trade
 */
economy.post('/trades/:id/reject', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const tradeId = c.req.param('id');

  try {
    const result = await EconomyService.rejectTrade(tradeId, agentId);
    return c.json({ success: true, data: result });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Cancel a trade (initiator only)
 */
economy.post('/trades/:id/cancel', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const tradeId = c.req.param('id');

  try {
    const result = await EconomyService.cancelTrade(tradeId, agentId);
    return c.json({ success: true, data: result });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default economy;
