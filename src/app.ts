import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from './middleware/logger.js';
import { errorHandler } from './middleware/error.js';
import { compactMiddleware } from './middleware/compact.js';
import api from './api/routes.js';

const app = new Hono();

// Global middleware
app.use('*', cors());
app.use('*', logger);
app.use('*', errorHandler);
app.use('*', compactMiddleware);

// Health check
app.get('/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'moltopia',
    },
  });
});

// API routes
app.route('/api', api);

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Not found',
  }, 404);
});

export default app;
