import { Hono } from 'hono';
import { LocationService } from '../../services/location.service.js';
import { PresenceService } from '../../services/presence.service.js';

const locations = new Hono();

/**
 * List all locations
 */
locations.get('/', async (c) => {
  const locationList = await LocationService.listLocations();

  return c.json({
    success: true,
    data: { locations: locationList },
  });
});

/**
 * Get location details
 */
locations.get('/:id', async (c) => {
  const id = c.req.param('id');
  const location = await LocationService.getLocation(id);

  if (!location) {
    return c.json({ success: false, error: 'Location not found' }, 404);
  }

  return c.json({
    success: true,
    data: { location },
  });
});

/**
 * Get agents at location
 */
locations.get('/:id/agents', async (c) => {
  const id = c.req.param('id');

  const agentsAtLocation = await PresenceService.getAgentsAtLocation(id);

  return c.json({
    success: true,
    data: {
      locationId: id,
      agents: agentsAtLocation.map((p) => ({
        id: p.agent.id,
        name: p.agent.name,
        avatarEmoji: p.agent.avatarEmoji,
        activity: p.activity,
        arrivedAt: p.arrivedAt,
      })),
    },
  });
});

export default locations;
