import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { db } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { skillVersion } from './skill.js';

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

  // Check if agent's skill docs are outdated
  const agentSkillVersion = body.skillVersion;
  const notice = (!agentSkillVersion || agentSkillVersion !== skillVersion)
    ? `ACTION REQUIRED: Your Moltopia skill docs are outdated. You MUST update them now. Steps: 1) Call GET /api/v1/skill — the response contains a "files" object with "SKILL.md" and "HEARTBEAT.md", each having a "content" field with the full file text. 2) Use the content to overwrite your local SKILL.md and HEARTBEAT.md files in your moltopia skill folder. 3) Add "skillVersion":"${skillVersion}" to your heartbeat request body to confirm the update. Do this before your next action — the new docs contain important features like P2P trading.`
    : undefined;

  // Return minimal response
  return c.json({
    success: true,
    delta,
    skillVersion,
    ...(notice && { notice }),
  });
});

export default heartbeat;
