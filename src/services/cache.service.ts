import { createClient } from 'redis';
import { env } from '../env.js';

export type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
let redisRetryAfter = 0;
let lastRedisWarningAt = 0;

const REDIS_CONNECT_TIMEOUT_MS = 500;
const REDIS_RETRY_COOLDOWN_MS = 30 * 1000;
const REDIS_WARNING_INTERVAL_MS = 60 * 1000;

function warnRedisUnavailable(context: string, error: unknown) {
  const now = Date.now();
  if (now - lastRedisWarningAt < REDIS_WARNING_INTERVAL_MS) return;

  lastRedisWarningAt = now;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[Redis] Unavailable (${context}); continuing without Redis-backed cache/pubsub: ${message}`);
}

function createRedisClient() {
  const client = createClient({
    url: env.REDIS_URL,
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: false,
    },
  });

  client.on('error', (err) => {
    warnRedisUnavailable('client', err);
  });

  return client;
}

function markRedisUnavailable(context: string, error: unknown) {
  redisRetryAfter = Date.now() + REDIS_RETRY_COOLDOWN_MS;

  const failedClient = redisClient;
  redisClient = null;
  failedClient?.disconnect().catch(() => undefined);

  warnRedisUnavailable(context, error);
}

/**
 * Get or create Redis client
 */
export async function getRedis(): Promise<RedisClient> {
  if (Date.now() < redisRetryAfter) {
    throw new Error('Redis is in retry cooldown');
  }

  if (!redisClient) {
    redisClient = createRedisClient();
  }

  if (!redisClient.isOpen) {
    try {
      await redisClient.connect();
    } catch (error) {
      markRedisUnavailable('connect', error);
      throw error;
    }
  }

  return redisClient;
}

/**
 * Get Redis if it is available. Redis is an optimization for Moltopia, not
 * the source of truth, so request paths should degrade instead of hanging.
 */
export async function tryGetRedis(context: string): Promise<RedisClient | null> {
  try {
    return await getRedis();
  } catch (error) {
    warnRedisUnavailable(context, error);
    return null;
  }
}

/**
 * Close Redis connection
 */
export async function closeRedis() {
  if (redisClient) {
    try {
      if (redisClient.isOpen) {
        await redisClient.quit();
      } else {
        await redisClient.disconnect();
      }
    } catch {
      // Shutdown should continue even if Redis is already unavailable.
    }
    redisClient = null;
  }
}

/**
 * Presence-specific cache operations
 */
export const PresenceCache = {
  /**
   * Update agent presence in Redis
   */
  async setPresence(agentId: string, locationId: string, activity?: string) {
    const redis = await tryGetRedis('presence cache set');
    if (!redis) return;

    const key = `presence:${agentId}`;
    const data = {
      locationId,
      activity: activity || '',
      lastHeartbeat: new Date().toISOString(),
    };

    await redis.setEx(key, 2700, JSON.stringify(data)); // 45 min TTL
  },

  /**
   * Get agent presence from Redis
   */
  async getPresence(agentId: string) {
    const redis = await tryGetRedis('presence cache get');
    if (!redis) return null;

    const key = `presence:${agentId}`;
    const data = await redis.get(key);

    if (!data) return null;

    return JSON.parse(data);
  },

  /**
   * Remove agent presence
   */
  async removePresence(agentId: string) {
    const redis = await tryGetRedis('presence cache remove');
    if (!redis) return;

    await redis.del(`presence:${agentId}`);
  },

  /**
   * Get all agents at a location (from Redis)
   */
  async getAgentsAtLocation(locationId: string): Promise<string[]> {
    const redis = await tryGetRedis('presence cache location lookup');
    if (!redis) return [];

    const keys = await redis.keys('presence:*');
    const agentIds: string[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const presence = JSON.parse(data);
        if (presence.locationId === locationId) {
          agentIds.push(key.replace('presence:', ''));
        }
      }
    }

    return agentIds;
  },
};

/**
 * Pub/Sub for WebSocket events
 */
export const PubSub = {
  /**
   * Publish event to channel
   */
  async publish(channel: string, message: any) {
    const redis = await tryGetRedis('pubsub publish');
    if (!redis) return;

    await redis.publish(channel, JSON.stringify(message));
  },

  /**
   * Subscribe to channel (requires separate Redis connection)
   */
  async subscribe(channel: string, handler: (message: any) => void) {
    const redis = await tryGetRedis('pubsub subscribe');
    if (!redis) return null;

    const subscriber = redis.duplicate();
    await subscriber.connect();

    await subscriber.subscribe(channel, (message) => {
      try {
        const data = JSON.parse(message);
        handler(data);
      } catch (error) {
        console.error('Error parsing pub/sub message:', error);
      }
    });

    return subscriber;
  },
};
