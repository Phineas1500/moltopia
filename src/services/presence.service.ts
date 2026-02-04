import { db } from '../db/index.js';
import { presence, agents, conversationMessages, conversations, worldEvents, locations } from '../db/schema.js';
import { eq, and, gt, inArray, sql, or, desc } from 'drizzle-orm';
import { PresenceCache, PubSub } from './cache.service.js';
import { Delta, isDeltaEmpty } from '../utils/delta.js';

/**
 * CRITICAL: Presence Service with Delta Calculation
 * This is the most frequently called code path in Moltopia
 * Must be hyper-efficient to keep token costs low
 */
export const PresenceService = {
  /**
   * Update agent presence (called on heartbeat)
   */
  async updatePresence(agentId: string, activity?: string) {
    const now = new Date();

    // Get current presence to check if activity changed
    const currentPresence = await db.query.presence.findFirst({
      where: eq(presence.agentId, agentId),
    });

    if (currentPresence) {
      await PresenceCache.setPresence(agentId, currentPresence.locationId, activity);
    }

    // Check if activity changed (and is being set to a new value)
    const activityChanged = activity !== undefined && currentPresence?.activity !== activity;

    // Update in Postgres (durable)
    await db
      .update(presence)
      .set({
        lastHeartbeat: now,
        activity: activity || sql`${presence.activity}`,
      })
      .where(eq(presence.agentId, agentId));

    // Update agent last_seen
    await db
      .update(agents)
      .set({ lastSeen: now })
      .where(eq(agents.id, agentId));

    // Broadcast activity change via WebSocket if activity was updated
    if (activityChanged && currentPresence) {
      const [agent] = await db
        .select({ name: agents.name, avatarEmoji: agents.avatarEmoji })
        .from(agents)
        .where(eq(agents.id, agentId));

      await PubSub.publish(`location:${currentPresence.locationId}`, {
        type: 'activity_changed',
        agentId,
        agentName: agent?.name || 'Unknown',
        avatarEmoji: agent?.avatarEmoji || '🤖',
        activity: activity || null,
        locationId: currentPresence.locationId,
      });
    }
  },

  /**
   * Calculate delta since last heartbeat
   * Returns only what changed to minimize tokens
   */
  async calculateDelta(agentId: string, since: Date): Promise<Delta> {
    const delta: Delta = {};

    // Get agent's current presence
    const agentPresence = await db.query.presence.findFirst({
      where: eq(presence.agentId, agentId),
      with: {
        location: true,
      },
    });

    if (!agentPresence) {
      return delta;
    }

    const locationId = agentPresence.locationId;

    // 1. Who arrived/left agent's current location?
    const locationChanges = await db
      .select({
        agentId: presence.agentId,
        name: agents.name,
        arrivedAt: presence.arrivedAt,
        lastHeartbeat: presence.lastHeartbeat,
      })
      .from(presence)
      .innerJoin(agents, eq(presence.agentId, agents.id))
      .where(
        and(
          eq(presence.locationId, locationId),
          gt(presence.arrivedAt, since)
        )
      );

    if (locationChanges.length > 0) {
      delta.arrived = locationChanges.map((change) => ({
        id: change.agentId,
        name: change.name,
      }));
    }

    // 2. Get agent's active conversations
    const agentConversations = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        sql`${conversations.participantIds}::jsonb ? ${agentId}`
      );

    const conversationIds = agentConversations.map((c) => c.id);

    // 3. New messages in agent's conversations?
    if (conversationIds.length > 0) {
      const newMessages = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationMessages)
        .where(
          and(
            inArray(conversationMessages.conversationId, conversationIds),
            gt(conversationMessages.createdAt, since)
          )
        );

      const messageCount = newMessages[0]?.count || 0;
      if (messageCount > 0) {
        delta.messages = messageCount;
      }
    }

    // 4. World events at agent's location?
    const events = await db
      .select()
      .from(worldEvents)
      .where(
        and(
          eq(worldEvents.locationId, locationId),
          gt(worldEvents.timestamp, since)
        )
      )
      .limit(5)
      .orderBy(worldEvents.timestamp);

    if (events.length > 0) {
      delta.events = events.map((e) => ({
        type: e.type,
        timestamp: e.timestamp,
        data: e.data,
      }));
    }

    return delta;
  },

  /**
   * Move agent to a new location
   */
  async moveAgent(agentId: string, newLocationId: string) {
    const now = new Date();

    // Get agent info for broadcasting
    const [agent] = await db
      .select({ name: agents.name, avatarEmoji: agents.avatarEmoji })
      .from(agents)
      .where(eq(agents.id, agentId));

    // Get current location
    const currentPresence = await db.query.presence.findFirst({
      where: eq(presence.agentId, agentId),
    });

    const oldLocationId = currentPresence?.locationId;

    // Update presence
    await db
      .update(presence)
      .set({
        locationId: newLocationId,
        arrivedAt: now,
        lastHeartbeat: now,
      })
      .where(eq(presence.agentId, agentId));

    // Update Redis cache
    await PresenceCache.setPresence(agentId, newLocationId);

    // Log departure from old location
    if (oldLocationId) {
      await db.insert(worldEvents).values({
        id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'departure',
        locationId: oldLocationId,
        actorId: agentId,
        timestamp: now,
        data: { newLocationId },
      });

      // Notify agents at old location via WebSocket
      await PubSub.publish(`location:${oldLocationId}`, {
        type: 'agent_departed',
        agentId,
        agentName: agent?.name || 'Unknown',
        locationId: oldLocationId,
        newLocationId,
      });
    }

    // Log arrival at new location
    await db.insert(worldEvents).values({
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'arrival',
      locationId: newLocationId,
      actorId: agentId,
      timestamp: now,
      data: { oldLocationId },
    });

    // Notify agents at new location via WebSocket
    await PubSub.publish(`location:${newLocationId}`, {
      type: 'agent_arrived',
      agentId,
      agentName: agent?.name || 'Unknown',
      avatarEmoji: agent?.avatarEmoji || '🤖',
      locationId: newLocationId,
      activity: currentPresence?.activity || null,
    });
  },

  /**
   * Create initial presence for new agent
   */
  async createPresence(agentId: string, locationId: string) {
    const now = new Date();

    // Get agent info for broadcasting
    const [agent] = await db
      .select({ name: agents.name, avatarEmoji: agents.avatarEmoji })
      .from(agents)
      .where(eq(agents.id, agentId));

    await db.insert(presence).values({
      agentId,
      locationId,
      arrivedAt: now,
      lastHeartbeat: now,
    });

    await PresenceCache.setPresence(agentId, locationId);

    // Log arrival
    await db.insert(worldEvents).values({
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'arrival',
      locationId,
      actorId: agentId,
      timestamp: now,
      data: { firstArrival: true },
    });

    // Broadcast arrival via WebSocket
    await PubSub.publish(`location:${locationId}`, {
      type: 'agent_arrived',
      agentId,
      agentName: agent?.name || 'Unknown',
      avatarEmoji: agent?.avatarEmoji || '🤖',
      locationId,
    });
  },

  /**
   * Remove presence (agent goes offline)
   */
  async removePresence(agentId: string) {
    const currentPresence = await db.query.presence.findFirst({
      where: eq(presence.agentId, agentId),
    });

    if (currentPresence) {
      await db.delete(presence).where(eq(presence.agentId, agentId));
      await PresenceCache.removePresence(agentId);

      // Log departure
      await db.insert(worldEvents).values({
        id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'departure',
        locationId: currentPresence.locationId,
        actorId: agentId,
        timestamp: new Date(),
        data: { offline: true },
      });
    }
  },

  /**
   * Get agent's current presence
   */
  async getPresence(agentId: string) {
    return db.query.presence.findFirst({
      where: eq(presence.agentId, agentId),
      with: {
        location: true,
      },
    });
  },

  /**
   * Get all agents at a location
   */
  async getAgentsAtLocation(locationId: string) {
    return db.query.presence.findMany({
      where: eq(presence.locationId, locationId),
      with: {
        agent: {
          columns: {
            id: true,
            name: true,
            avatarEmoji: true,
            status: true,
          },
        },
      },
    });
  },

  /**
   * Cleanup stale presence (agents who haven't sent heartbeat in 45+ min)
   */
  async cleanupStalePresence() {
    const staleThreshold = new Date(Date.now() - 45 * 60 * 1000); // 45 minutes

    const staleAgents = await db
      .select({ agentId: presence.agentId })
      .from(presence)
      .where(sql`${presence.lastHeartbeat} < ${staleThreshold.toISOString()}`);

    for (const { agentId } of staleAgents) {
      await this.removePresence(agentId);
      await db
        .update(agents)
        .set({ status: 'offline' })
        .where(eq(agents.id, agentId));
    }

    return staleAgents.length;
  },

  /**
   * Get agent's presence history (where they've been)
   */
  async getPresenceHistory(agentId: string, limit: number = 10) {
    // Get arrival and departure events for this agent
    const events = await db
      .select({
        id: worldEvents.id,
        type: worldEvents.type,
        locationId: worldEvents.locationId,
        locationName: locations.name,
        timestamp: worldEvents.timestamp,
        data: worldEvents.data,
      })
      .from(worldEvents)
      .leftJoin(locations, eq(worldEvents.locationId, locations.id))
      .where(
        and(
          eq(worldEvents.actorId, agentId),
          or(
            eq(worldEvents.type, 'arrival'),
            eq(worldEvents.type, 'departure')
          )
        )
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(limit * 2); // Get more events to pair arrivals/departures

    // Process events into location visits
    const visits: Array<{
      locationId: string;
      locationName: string;
      arrivedAt: Date;
      departedAt: Date | null;
      duration: number | null; // in minutes
    }> = [];

    // Group by location visits (arrival followed by departure)
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      if (event.type === 'arrival' && event.locationId) {
        // Look for matching departure (should be the next event at same location)
        let departedAt: Date | null = null;

        for (let j = i + 1; j < events.length; j++) {
          if (events[j].type === 'departure' && events[j].locationId === event.locationId) {
            departedAt = events[j].timestamp;
            break;
          }
        }

        const duration = departedAt
          ? Math.round((event.timestamp.getTime() - departedAt.getTime()) / 60000)
          : null;

        visits.push({
          locationId: event.locationId,
          locationName: event.locationName || event.locationId,
          arrivedAt: event.timestamp,
          departedAt,
          duration,
        });

        if (visits.length >= limit) break;
      }
    }

    return visits;
  },
};
