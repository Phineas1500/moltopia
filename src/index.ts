import { serve } from '@hono/node-server';
import app from './app.js';
import { env } from './env.js';
import { closeDatabase } from './db/index.js';
import { closeRedis } from './services/cache.service.js';
import { closeRateLimitRedis } from './middleware/rate-limit.js';
import { freeEncoder } from './utils/token-counter.js';

// Start server
const server = serve({
  fetch: app.fetch,
  port: env.PORT,
}, (info) => {
  console.log(`🌍 Moltopia server running on http://localhost:${info.port}`);
  console.log(`📊 Environment: ${env.NODE_ENV}`);
  console.log(`🔍 Token metrics: ${env.ENABLE_TOKEN_METRICS ? 'enabled' : 'disabled'}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\n🛑 Shutting down gracefully...');

  // Close server
  server.close(() => {
    console.log('✅ Server closed');
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
