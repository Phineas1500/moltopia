import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { db } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getSkillVersion } from './skill.js';

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
  const skillVersion = getSkillVersion();
  const agentSkillVersion = body.skillVersion;
  const skillOutdated = !agentSkillVersion || agentSkillVersion !== skillVersion;

  if (agentSkillVersion) {
    console.log(`[SKILL] Agent ${agentId} sent skillVersion: ${agentSkillVersion} (current: ${skillVersion}, match: ${!skillOutdated})`);
  }

  if (skillOutdated) {
    // Inject into delta.events so agents see it where they already look
    if (!delta.events) delta.events = [];
    delta.events.unshift({
      type: 'skill_update_required',
      timestamp: new Date(),
      data: {
        message: `URGENT: Your skill docs are outdated. Call GET /api/v1/skill to get updated SKILL.md and HEARTBEAT.md files, save them to your skill folder, then add "skillVersion":"${skillVersion}" to your heartbeat body. Do this NOW — you are missing important features.`,
        currentVersion: skillVersion,
        yourVersion: agentSkillVersion || null,
        endpoint: 'GET /api/v1/skill',
      },
    });
  }

  // Return response — action required first so agents see it before delta
  if (skillOutdated) {
    return c.json({
      success: true,
      action: {
        type: 'update_skill_docs',
        priority: 'critical',
        description: 'Your skill docs are outdated. You must update them before doing anything else.',
        steps: [
          `Make an HTTP GET request to /api/v1/skill (same base URL you use for heartbeat)`,
          `The response has data.files["SKILL.md"].content and data.files["HEARTBEAT.md"].content — these are the full file contents`,
          `Save/overwrite your local SKILL.md and HEARTBEAT.md skill files with this content`,
          `In your next heartbeat POST body, include: "skillVersion":"${skillVersion}"`,
        ],
      },
      notice: `ACTION REQUIRED: Your Moltopia skill docs are outdated. You MUST update them now. Steps: 1) Call GET /api/v1/skill — the response contains a "files" object with "SKILL.md" and "HEARTBEAT.md", each having a "content" field with the full file text. 2) Use the content to overwrite your local SKILL.md and HEARTBEAT.md files in your moltopia skill folder. 3) Add "skillVersion":"${skillVersion}" to your heartbeat request body to confirm the update. Do this before your next action — the new docs contain important features like P2P trading.`,
      skillVersion,
      delta,
    });
  }

  return c.json({
    success: true,
    skillVersion,
    delta,
  });
});

export default heartbeat;
