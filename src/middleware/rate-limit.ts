import { Context, Next } from 'hono';
import { env } from '../env.js';
import { tryGetRedis } from '../services/cache.service.js';

const localRateLimitBuckets = new Map<string, number[]>();

/**
 * Rate limiting middleware using Redis
 * Limits requests per agent based on their ID
 */
export async function rateLimitMiddleware(c: Context, next: Next) {
  const agentId = c.get('agentId') as string | undefined;

  // Skip rate limiting if no agent (public endpoints)
  if (!agentId) {
    await next();
    return;
  }

  const key = `ratelimit:${agentId}`;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const redis = await tryGetRedis('rate limit');

  if (!redis) {
    const recent = (localRateLimitBuckets.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
    recent.push(now);
    localRateLimitBuckets.set(key, recent);

    const count = recent.length;
    if (count > env.API_RATE_LIMIT_PER_MINUTE) {
      return c.json(
        {
          success: false,
          error: 'Rate limit exceeded',
          message: `Maximum ${env.API_RATE_LIMIT_PER_MINUTE} requests per minute`,
        },
        429
      );
    }

    c.header('X-RateLimit-Limit', env.API_RATE_LIMIT_PER_MINUTE.toString());
    c.header('X-RateLimit-Remaining', (env.API_RATE_LIMIT_PER_MINUTE - count).toString());

    await next();
    return;
  }

  // Use Redis sorted set to track requests in time window
  const multi = redis.multi();

  // Remove old entries outside the time window
  multi.zRemRangeByScore(key, 0, now - windowMs);

  // Add current request
  multi.zAdd(key, { score: now, value: `${now}` });

  // Count requests in window
  multi.zCard(key);

  // Set expiry on the key
  multi.expire(key, 120);

  const results = await multi.exec();
  const count = results[2] as number;

  // Check if over limit
  if (count > env.API_RATE_LIMIT_PER_MINUTE) {
    return c.json(
      {
        success: false,
        error: 'Rate limit exceeded',
        message: `Maximum ${env.API_RATE_LIMIT_PER_MINUTE} requests per minute`,
      },
      429
    );
  }

  // Add rate limit headers
  c.header('X-RateLimit-Limit', env.API_RATE_LIMIT_PER_MINUTE.toString());
  c.header('X-RateLimit-Remaining', (env.API_RATE_LIMIT_PER_MINUTE - count).toString());

  await next();
}

/**
 * Close Redis connection
 */
export async function closeRateLimitRedis() {
  localRateLimitBuckets.clear();
}
