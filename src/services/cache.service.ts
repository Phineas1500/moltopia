import { createClient } from 'redis';
import { env } from '../env.js';

export type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;

/**
 * Get or create Redis client
 */
export async function getRedis(): Promise<RedisClient> {
  if (!redisClient) {
    redisClient = createClient({ url: env.REDIS_URL });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err);
    });

    await redisClient.connect();
  }

  return redisClient;
}

/**
 * Close Redis connection
 */
export async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
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
    const redis = await getRedis();
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
    const redis = await getRedis();
    const key = `presence:${agentId}`;
    const data = await redis.get(key);

    if (!data) return null;

    return JSON.parse(data);
  },

  /**
   * Remove agent presence
   */
  async removePresence(agentId: string) {
    const redis = await getRedis();
    await redis.del(`presence:${agentId}`);
  },

  /**
   * Get all agents at a location (from Redis)
   */
  async getAgentsAtLocation(locationId: string): Promise<string[]> {
    const redis = await getRedis();
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
    const redis = await getRedis();
    await redis.publish(channel, JSON.stringify(message));
  },

  /**
   * Subscribe to channel (requires separate Redis connection)
   */
  async subscribe(channel: string, handler: (message: any) => void) {
    const subscriber = redisClient!.duplicate();
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
