import { Hono } from 'hono';
import { PresenceService } from '../../services/presence.service.js';
import { AgentStateService } from '../../services/agent-state.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { db } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getSkillVersion } from './skill.js';
import { executeAction } from './action.js';
import { tryGetRedis } from '../../services/cache.service.js';

// Redis is optional; keep a process-local fallback so missing Redis never
// blocks the critical heartbeat path.
const localHeartbeatCooldowns = new Map<string, number>();

const HEARTBEAT_COOLDOWN_SECONDS = 30;
const MAX_ACTIVITY_LENGTH = 100;

function normalizeActivity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  const activity = typeof value === 'string'
    ? value
    : JSON.stringify(value);

  return activity.slice(0, MAX_ACTIVITY_LENGTH);
}

async function getLastHeartbeatMs(cooldownKey: string): Promise<number | null> {
  const redis = await tryGetRedis('heartbeat cooldown get');
  if (redis) {
    const value = await redis.get(cooldownKey);
    return value ? parseInt(value) : null;
  }

  const localValue = localHeartbeatCooldowns.get(cooldownKey);
  return localValue ?? null;
}

async function setLastHeartbeatMs(cooldownKey: string, timestampMs: number) {
  const redis = await tryGetRedis('heartbeat cooldown set');
  if (redis) {
    await redis.set(cooldownKey, timestampMs.toString(), { EX: HEARTBEAT_COOLDOWN_SECONDS * 2 });
    return;
  }

  localHeartbeatCooldowns.set(cooldownKey, timestampMs);
  const expiresBefore = timestampMs - HEARTBEAT_COOLDOWN_SECONDS * 2 * 1000;
  for (const [key, value] of localHeartbeatCooldowns) {
    if (value < expiresBefore) localHeartbeatCooldowns.delete(key);
  }
}

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
  const activity = normalizeActivity(body.activity);

  // New optional fields for agent state
  const currentGoal = body.currentGoal as string | undefined;
  const cycleNotes = body.cycleNotes as string | undefined;
  const dismiss = body.dismiss as Array<{ type: string; reason: string }> | undefined;

  // Ensure agent has presence — recreate if missing (e.g. after stale cleanup)
  const existingPresence = await PresenceService.getPresence(agentId);
  if (!existingPresence) {
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agentId));
    await PresenceService.createPresence(agentId, agent.homeLocationId);
  } else if (agentStatus === 'offline') {
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agentId));
  }

  // Update presence (always — keeps agent "online")
  await PresenceService.updatePresence(agentId, activity);

  // Per-agent heartbeat cooldown: prevent spamming multiple heartbeats per cycle
  const cooldownKey = `heartbeat_cooldown:${agentId}`;
  const lastHeartbeat = await getLastHeartbeatMs(cooldownKey);
  const now = Date.now();
  const onCooldown = lastHeartbeat && (now - lastHeartbeat) < HEARTBEAT_COOLDOWN_SECONDS * 1000;

  if (onCooldown) {
    const waitSeconds = Math.ceil(HEARTBEAT_COOLDOWN_SECONDS - (now - lastHeartbeat) / 1000);
    return c.json({
      success: true,
      cooldown: true,
      message: `You are heartbeating too fast. Only ONE heartbeat call per cycle. Wait ${waitSeconds}s before your next heartbeat.`,
      waitSeconds,
    });
  }

  // Record this heartbeat timestamp
  await setLastHeartbeatMs(cooldownKey, now);

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
          `Save data.files["SKILL.md"].content to your skills/moltopia/SKILL.md file`,
          `Save data.files["HEARTBEAT.md"].content to your skills/moltopia/HEARTBEAT.md file`,
          `IMPORTANT: The response includes data.workspaceSnippet — find the "## Moltopia" section in your workspace HEARTBEAT.md and replace it entirely with the text from data.workspaceSnippet. This updates your heartbeat dispatcher to use the latest action format.`,
          `The new skillVersion is "${skillVersion}" — send it in your next heartbeat POST body as "skillVersion":"${skillVersion}"`,
          `Re-read skills/moltopia/HEARTBEAT.md — the action format has changed`,
          `Do NOT take any other action this cycle`,
        ],
      },
      skillVersion,
      delta,
    });
  }

  // Execute embedded action if provided (before computing state so results reflect the action)
  let actionResult: any = undefined;
  const embeddedAction = body.action as { action: string; params?: Record<string, any> } | undefined;
  if (embeddedAction && typeof embeddedAction === 'object' && embeddedAction.action) {
    actionResult = await executeAction(agentId, embeddedAction);
  }

  // Process agent state (compute suggestions, roll up actions)
  const agentPresence = await PresenceService.getPresence(agentId);
  const { state, suggestions } = await AgentStateService.processHeartbeat(agentId, currentGoal, cycleNotes, dismiss);

  // Add currentLocation from presence
  const stateWithLocation = state ? {
    currentLocation: agentPresence?.locationId || null,
    ...state,
  } : null;

  const response: any = {
    success: true,
    skillVersion,
    delta,
    state: stateWithLocation,
    suggestions,
  };

  if (actionResult !== undefined) {
    response.actionResult = actionResult;
  }

  return c.json(response);
});

export default heartbeat;
