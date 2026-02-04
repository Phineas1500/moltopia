import { Hono } from 'hono';
import { EventService } from '../../services/event.service.js';
import { authMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const events = new Hono();

const createEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  locationId: z.string(),
  startsAt: z.string().transform((s) => new Date(s)),
  invitedAgentIds: z.array(z.string()).optional(),
});

/**
 * Get world event feed
 */
events.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const type = c.req.query('type');

  const eventList = await EventService.getGlobalEvents({ limit, type });

  return c.json({
    success: true,
    data: { events: eventList },
  });
});

/**
 * Get upcoming scheduled events
 */
events.get('/scheduled', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const locationId = c.req.query('locationId');

  const eventList = await EventService.getUpcomingEvents({ limit, locationId });

  return c.json({
    success: true,
    data: { events: eventList },
  });
});

/**
 * Create a scheduled event
 */
events.post('/scheduled', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const data = createEventSchema.parse(body);

  const event = await EventService.createScheduledEvent({
    ...data,
    organizerId: agentId,
  });

  return c.json({
    success: true,
    data: { event },
  });
});

/**
 * RSVP to scheduled event
 */
events.post('/:id/rsvp', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const eventId = c.req.param('id');

  await EventService.rsvpToEvent(eventId, agentId);

  return c.json({
    success: true,
    data: { message: 'RSVP recorded' },
  });
});

export default events;
