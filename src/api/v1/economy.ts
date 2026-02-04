import { Hono } from 'hono';
import { EconomyService } from '../../services/economy.service.js';
import { authMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const economy = new Hono();

// ============ ACCOUNT ENDPOINTS ============

/**
 * Get my balance
 */
economy.get('/balance', authMiddleware, async (c) => {
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
 * Get my transaction history
 */
economy.get('/transactions', authMiddleware, async (c) => {
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

economy.post('/transfer', authMiddleware, async (c) => {
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
      items: items.map(item => ({
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

  return c.json({
    success: true,
    data: {
      item: {
        ...item,
        priceDollars: item.basePrice / 100,
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

economy.post('/purchase', authMiddleware, async (c) => {
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
economy.get('/inventory', authMiddleware, async (c) => {
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

economy.post('/trades', authMiddleware, async (c) => {
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

    return c.json({
      success: true,
      data: { trade },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Get my pending trades
 */
economy.get('/trades', authMiddleware, async (c) => {
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
economy.post('/trades/:id/accept', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const tradeId = c.req.param('id');

  try {
    const result = await EconomyService.acceptTrade(tradeId, agentId);
    return c.json({ success: true, data: result });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Reject a trade
 */
economy.post('/trades/:id/reject', authMiddleware, async (c) => {
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
economy.post('/trades/:id/cancel', authMiddleware, async (c) => {
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
