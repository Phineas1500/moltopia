import { serve } from '@hono/node-server';
import app from './app.js';
import { env } from './env.js';
import { closeDatabase } from './db/index.js';
import { closeRedis } from './services/cache.service.js';
import { closeRateLimitRedis } from './middleware/rate-limit.js';
import { freeEncoder } from './utils/token-counter.js';
import { createWebSocketServer, initRedisSubscriber, getConnectedCount } from './api/ws/handler.js';
import { PresenceService } from './services/presence.service.js';
import { WorldDemandService } from './services/world-demand.service.js';
import { MarketService } from './services/market.service.js';

// WebSocket port (HTTP port + 1)
const WS_PORT = env.PORT + 1;

// Start HTTP server
const server = serve({
  fetch: app.fetch,
  port: env.PORT,
}, (info) => {
  console.log(`🌍 Moltopia server running on http://localhost:${info.port}`);
  console.log(`📊 Environment: ${env.NODE_ENV}`);
  console.log(`🔍 Token metrics: ${env.ENABLE_TOKEN_METRICS ? 'enabled' : 'disabled'}`);
});

// Start WebSocket server
const wss = createWebSocketServer(WS_PORT);
console.log(`🔌 WebSocket server running on ws://localhost:${WS_PORT}`);

// Initialize Redis subscriber for real-time event broadcasting
initRedisSubscriber();

// Stale presence cleanup - runs every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(async () => {
  try {
    const cleaned = await PresenceService.cleanupStalePresence();
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} stale agent(s)`);
    }
  } catch (error) {
    console.error('❌ Stale presence cleanup failed:', error);
  }
}, CLEANUP_INTERVAL);
console.log('🧹 Stale presence cleanup scheduled (every 5 minutes)');

// Market order expiration - returns reserved items/funds for stale orders.
const ORDER_EXPIRATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
let orderExpirationRunning = false;

async function runOrderExpirationPass(reason: string) {
  if (orderExpirationRunning) return;
  orderExpirationRunning = true;

  try {
    const result = await MarketService.expireExpiredOrders();
    if (result.expiredCount > 0) {
      console.log(
        `⏳ Expired ${result.expiredCount} market order(s) (${result.sellOrderCount} sell, ${result.buyOrderCount} buy), returned ${result.returnedItemCount} item(s), refunded $${(result.refundedCents / 100).toFixed(2)} [${reason}]`,
      );
    }
  } catch (error) {
    console.error('❌ Market order expiration pass failed:', error);
  } finally {
    orderExpirationRunning = false;
  }
}

setTimeout(() => {
  void runOrderExpirationPass('startup');
}, 15 * 1000);
setInterval(() => {
  void runOrderExpirationPass('scheduler');
}, ORDER_EXPIRATION_INTERVAL);
console.log('⏳ Market order expiration scheduled (every 5 minutes)');

// World demand - recirculate treasury money into stale crafted-item asks.
const WORLD_DEMAND_INTERVAL = 5 * 60 * 1000; // 5 minutes
const WORLD_DEMAND_MAX_ORDERS = 8;
const WORLD_DEMAND_MAX_SPEND_CENTS = 50000; // $500/pass
let worldDemandRunning = false;

async function runWorldDemandPass(reason: string) {
  if (worldDemandRunning) return;
  worldDemandRunning = true;

  try {
    const result = await WorldDemandService.runOnce({
      reason,
      maxOrders: WORLD_DEMAND_MAX_ORDERS,
      maxSpendCents: WORLD_DEMAND_MAX_SPEND_CENTS,
    });

    if (result.createdOrders.length > 0) {
      console.log(
        `💸 World demand bought/reserved ${result.createdOrders.length} item type(s) for $${(result.spentOrReservedCents / 100).toFixed(2)}`,
      );
    }
  } catch (error) {
    console.error('❌ World demand pass failed:', error);
  } finally {
    worldDemandRunning = false;
  }
}

setTimeout(() => {
  void runWorldDemandPass('startup');
}, 30 * 1000);
setInterval(() => {
  void runWorldDemandPass('scheduler');
}, WORLD_DEMAND_INTERVAL);
console.log('💸 World demand scheduled (every 5 minutes)');

// Log connected clients periodically in dev mode
if (env.NODE_ENV === 'development') {
  setInterval(() => {
    const count = getConnectedCount();
    if (count > 0) {
      console.log(`[WS] ${count} client(s) connected`);
    }
  }, 60000); // Every minute
}

// Graceful shutdown
const shutdown = async () => {
  console.log('\n🛑 Shutting down gracefully...');

  // Close WebSocket server
  wss.close(() => {
    console.log('✅ WebSocket server closed');
  });

  // Close HTTP server
  server.close(() => {
    console.log('✅ HTTP server closed');
  });

  // Close database connections
  await closeDatabase();
  console.log('✅ Database connection closed');

  // Close Redis connections
  await closeRedis();
  await closeRateLimitRedis();
  console.log('✅ Redis connections closed');

  // Free token encoder
  freeEncoder();
  console.log('✅ Token encoder freed');

  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
