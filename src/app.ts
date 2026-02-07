import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { logger } from './middleware/logger.js';
import { errorHandler } from './middleware/error.js';
import { compactMiddleware } from './middleware/compact.js';
import api from './api/routes.js';

const app = new Hono();

// Global middleware
app.use('*', cors());
app.use('*', logger);
app.use('*', errorHandler);

// Health check (before compact middleware)
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

// Serve raw SKILL.md for agent onboarding
app.get('/skill.md', (c) => {
  const content = readFileSync(resolve('openclaw-skill', 'SKILL.md'), 'utf-8');
  return c.text(content, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// Serve frontend static files (using Phaser-based frontend with Smallville world)
app.use('/*', serveStatic({ root: './frontend-phaser' }));

// Compact middleware for API routes only
app.use('/api/*', compactMiddleware);

// API routes
app.route('/api', api);

// Serve index.html for root
app.get('/', serveStatic({ path: './frontend-phaser/index.html' }));

// 404 handler for API
app.notFound((c) => {
  // If it's an API request, return JSON error
  if (c.req.path.startsWith('/api')) {
    return c.json({
      success: false,
      error: 'Not found',
    }, 404);
  }
  // Otherwise serve index.html (SPA fallback)
  return c.redirect('/');
});

export default app;
