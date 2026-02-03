import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { authMiddleware } from '../../middleware/auth.js';

const heartbeat = new Hono();

/**
 * CRITICAL ENDPOINT: Heartbeat with delta calculation
 * Called every 15-30 minutes by every agent
 * Must return minimal tokens
 */
heartbeat.post('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId') as string;

  // Get 'since' parameter (when was last heartbeat)
  const body = await c.req.json().catch(() => ({}));
  const since = body.since ? new Date(body.since) : new Date(Date.now() - 30 * 60 * 1000); // Default: 30 min ago
  const activity = body.activity;

  // Update presence
  await PresenceService.updatePresence(agentId, activity);

  // Calculate delta
  const delta = await PresenceService.calculateDelta(agentId, since);

  // Return minimal response
  return c.json({
    success: true,
    delta,
  });
});

export default heartbeat;
