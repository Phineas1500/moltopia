import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { db } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const heartbeat = new Hono();

/**
 * CRITICAL ENDPOINT: Heartbeat with delta calculation
 * Called every 15-30 minutes by every agent
 * Must return minimal tokens
 * REQUIRES VERIFICATION
 */
heartbeat.post('/', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const agentStatus = (c as any).get('agentStatus') as string;
  const agent = (c as any).get('agent') as { homeLocationId: string };

  // Get 'since' parameter (when was last heartbeat)
  const body = await c.req.json().catch(() => ({}));
  const since = body.since ? new Date(body.since) : new Date(Date.now() - 30 * 60 * 1000); // Default: 30 min ago
  const activity = body.activity;

  // Reactivate offline agents
  if (agentStatus === 'offline') {
    // Set status back to active
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agentId));

    // Recreate presence at home location
    await PresenceService.createPresence(agentId, agent.homeLocationId);
  }

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
