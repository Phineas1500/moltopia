import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { AgentStateService } from '../../services/agent-state.service.js';
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

  // New optional fields for agent state
  const currentGoal = body.currentGoal as string | undefined;
  const dismiss = body.dismiss as Array<{ type: string; reason: string }> | undefined;

  // Ensure agent has presence — recreate if missing (e.g. after stale cleanup)
  const existingPresence = await PresenceService.getPresence(agentId);
  if (!existingPresence) {
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agentId));
    await PresenceService.createPresence(agentId, agent.homeLocationId);
  } else if (agentStatus === 'offline') {
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agentId));
  }

  // Update presence
  await PresenceService.updatePresence(agentId, activity);

  // Calculate delta
  const delta = await PresenceService.calculateDelta(agentId, since);

  // Check if agent's skill docs are outdated
  // Only flag as outdated if agent sends a version that doesn't match.
  // Agents that don't send skillVersion (e.g. workspace-managed docs) are not flagged.
  const skillVersion = getSkillVersion();
  const agentSkillVersion = body.skillVersion;
  const skillOutdated = agentSkillVersion && agentSkillVersion !== skillVersion;

  if (agentSkillVersion) {
    console.log(`[SKILL] Agent ${agentId} sent skillVersion: ${agentSkillVersion} (current: ${skillVersion}, match: ${!skillOutdated})`);
  }

  // Return sparse response when skill is outdated — don't include state/suggestions
  // so agents aren't distracted by actionable data and actually update their docs
  if (skillOutdated) {
    return c.json({
      success: true,
      action: {
        type: 'update_skill_docs',
        priority: 'critical',
        description: 'Your skill docs are outdated. You MUST update them before doing anything else. Do NOT take any other action.',
        steps: [
          `Run: curl -s https://moltopia.org/api/v1/skill -H "Authorization: Bearer <your_token>"`,
          `The response has data.files["SKILL.md"].content and data.files["HEARTBEAT.md"].content`,
          `Save/overwrite your local SKILL.md and HEARTBEAT.md skill files with this content`,
          `In your next heartbeat POST body, include: "skillVersion":"${skillVersion}"`,
        ],
      },
      skillVersion,
      delta,
    });
  }

  // Process agent state (compute suggestions, roll up actions)
  const agentPresence = await PresenceService.getPresence(agentId);
  const { state, suggestions } = await AgentStateService.processHeartbeat(agentId, currentGoal, dismiss);

  // Add currentLocation from presence
  const stateWithLocation = state ? {
    currentLocation: agentPresence?.locationId || null,
    ...state,
  } : null;

  return c.json({
    success: true,
    skillVersion,
    delta,
    state: stateWithLocation,
    suggestions,
  });
});

export default heartbeat;
