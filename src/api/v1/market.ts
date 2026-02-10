import { Hono } from 'hono';
import { MarketService } from '../../services/market.service.js';
import { AgentStateService } from '../../services/agent-state.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const market = new Hono();

/**
 * Get market summary (all items with prices)
 */
market.get('/summary', async (c) => {
  const summary = await MarketService.getMarketSummary();

  return c.json({
    success: true,
    data: {
      items: summary.map(s => ({
        ...s,
        bestBidDollars: s.bestBid ? s.bestBid / 100 : null,
        bestAskDollars: s.bestAsk ? s.bestAsk / 100 : null,
        lastPriceDollars: s.lastPrice ? s.lastPrice / 100 : null,
      })),
    },
  });
});

/**
 * Get order book for an item
 */
market.get('/orderbook/:itemId', async (c) => {
  const itemId = c.req.param('itemId');
  const orderBook = await MarketService.getOrderBook(itemId);

  return c.json({
    success: true,
    data: {
      bids: orderBook.bids.map(b => ({
        ...b,
        priceDollars: b.price / 100,
      })),
      asks: orderBook.asks.map(a => ({
        ...a,
        priceDollars: a.price / 100,
      })),
      lastPrice: orderBook.lastPrice,
      lastPriceDollars: orderBook.lastPrice ? orderBook.lastPrice / 100 : null,
      spread: orderBook.spread,
      spreadDollars: orderBook.spread ? orderBook.spread / 100 : null,
    },
  });
});

/**
 * Get price history for an item
 */
market.get('/history/:itemId', async (c) => {
  const itemId = c.req.param('itemId');
  const limit = parseInt(c.req.query('limit') || '50');

  const history = await MarketService.getPriceHistory(itemId, limit);

  return c.json({
    success: true,
    data: {
      trades: history.map(t => ({
        ...t,
        priceDollars: t.price / 100,
      })),
    },
  });
});

/**
 * Place an order
 */
const placeOrderSchema = z.object({
  itemId: z.string(),
  orderType: z.enum(['buy', 'sell']),
  price: z.number().positive(), // In dollars
  quantity: z.number().int().positive(),
  expiresInHours: z.number().positive().optional(),
});

market.post('/orders', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = placeOrderSchema.parse(body);

  try {
    const order = await MarketService.placeOrder({
      agentId,
      itemId: data.itemId,
      orderType: data.orderType,
      price: Math.round(data.price * 100), // Convert to cents
      quantity: data.quantity,
      expiresInHours: data.expiresInHours,
    });

    await AgentStateService.recordAction(agentId, 'market');

    return c.json({
      success: true,
      data: { order },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

/**
 * Get my open orders
 */
market.get('/orders', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const orders = await MarketService.getMyOrders(agentId);

  return c.json({
    success: true,
    data: {
      orders: orders.map(o => ({
        ...o,
        priceDollars: o.price / 100,
        remainingQuantity: o.quantity - o.filledQuantity,
      })),
    },
  });
});

/**
 * Cancel an order
 */
market.delete('/orders/:orderId', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const orderId = c.req.param('orderId');

  try {
    const result = await MarketService.cancelOrder(orderId, agentId);

    await AgentStateService.recordAction(agentId, 'market');

    return c.json({ success: true, data: result });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default market;
