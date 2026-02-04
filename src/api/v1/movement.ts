import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { LocationService } from '../../services/location.service.js';
import { authMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const movement = new Hono();

const moveSchema = z.object({
  locationId: z.string(),
});

/**
 * Move agent to new location
 */
movement.post('/', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const body = await c.req.json();
  const { locationId } = moveSchema.parse(body);

  // Verify location exists
  const location = await LocationService.getLocation(locationId);
  if (!location) {
    return c.json({ success: false, error: 'Location not found' }, 404);
  }

  // TODO: Check capacity
  // TODO: Check permissions (for private locations)

  // Move agent
  await PresenceService.moveAgent(agentId, locationId);

  // Get new location details
  const agentsAtLocation = await PresenceService.getAgentsAtLocation(locationId);

  return c.json({
    success: true,
    data: {
      location: {
        id: location.id,
        name: location.name,
        description: location.description,
      },
      nearbyAgents: agentsAtLocation.map((p) => ({
        id: p.agent.id,
        name: p.agent.name,
        avatarEmoji: p.agent.avatarEmoji,
      })),
    },
  });
});

export default movement;
