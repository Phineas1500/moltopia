import { Context, Next } from 'hono';
import { env } from '../env.js';

/**
 * Request logging middleware
 */
export async function logger(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  // Log in JSON format for production, readable format for development
  if (env.NODE_ENV === 'production') {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        method,
        path,
        status,
        duration,
      })
    );
  } else {
    const statusColor = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
    console.log(
      `${method} ${path} ${statusColor}${status}\x1b[0m ${duration}ms`
    );
  }
}
