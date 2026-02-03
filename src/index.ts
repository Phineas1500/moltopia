import { serve } from '@hono/node-server';
import app from './app.js';
import { env } from './env.js';
import { closeDatabase } from './db/index.js';
import { closeRedis } from './services/cache.service.js';
import { closeRateLimitRedis } from './middleware/rate-limit.js';
import { freeEncoder } from './utils/token-counter.js';
import { createWebSocketServer, initRedisSubscriber, getConnectedCount } from './api/ws/handler.js';

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
