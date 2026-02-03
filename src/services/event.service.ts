import { db } from '../db/index.js';
import { worldEvents, scheduledEvents } from '../db/schema.js';
import { eq, and, gt, sql } from 'drizzle-orm';

export const EventService = {
  /**
   * Log a world event
   */
  async logEvent(data: {
    type: string;
    locationId?: string;
    actorId?: string;
    data?: any;
  }) {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [event] = await db
      .insert(worldEvents)
      .values({
        id,
        type: data.type,
        locationId: data.locationId,
        actorId: data.actorId,
        data: data.data || {},
        timestamp: new Date(),
      })
      .returning();

    return event;
  },

  /**
   * Get recent events at a location
   */
  async getLocationEvents(locationId: string, params: { limit?: number; since?: Date }) {
    const { limit = 20, since } = params;

    const conditions = [eq(worldEvents.locationId, locationId)];

    if (since) {
      conditions.push(gt(worldEvents.timestamp, since));
    }

    return db.query.worldEvents.findMany({
      where: and(...conditions),
      limit,
      orderBy: (events, { desc }) => [desc(events.timestamp)],
    });
  },

  /**
   * Get global event feed
   */
  async getGlobalEvents(params: { limit?: number; type?: string }) {
    const { limit = 50, type } = params;

    const conditions = type ? [eq(worldEvents.type, type)] : [];

    return db.query.worldEvents.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit,
      orderBy: (events, { desc }) => [desc(events.timestamp)],
    });
  },

  /**
   * Create a scheduled event
   */
  async createScheduledEvent(data: {
    title: string;
    description?: string;
    organizerId: string;
    locationId: string;
    startsAt: Date;
    invitedAgentIds?: string[];
  }) {
    const id = `sevt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [event] = await db
      .insert(scheduledEvents)
      .values({
        id,
        title: data.title,
        description: data.description,
        organizerId: data.organizerId,
        locationId: data.locationId,
        startsAt: data.startsAt,
        invitedAgentIds: data.invitedAgentIds || [],
        attendingAgentIds: [],
      })
      .returning();

    return event;
  },

  /**
   * RSVP to scheduled event
   */
  async rsvpToEvent(eventId: string, agentId: string) {
    const event = await db.query.scheduledEvents.findFirst({
      where: eq(scheduledEvents.id, eventId),
    });

    if (!event) {
      throw new Error('Event not found');
    }

    // Add to attending list
    const attending = [...(event.attendingAgentIds as string[]), agentId];

    await db
      .update(scheduledEvents)
      .set({
        attendingAgentIds: attending,
      })
      .where(eq(scheduledEvents.id, eventId));
  },

  /**
   * Get upcoming scheduled events
   */
  async getUpcomingEvents(params: { limit?: number; locationId?: string }) {
    const { limit = 20, locationId } = params;

    const conditions = [gt(scheduledEvents.startsAt, new Date())];

    if (locationId) {
      conditions.push(eq(scheduledEvents.locationId, locationId));
    }

    return db.query.scheduledEvents.findMany({
      where: and(...conditions),
      limit,
      orderBy: (events, { asc }) => [asc(events.startsAt)],
    });
  },
};
