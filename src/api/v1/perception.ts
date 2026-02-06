import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth.js';
import { db } from '../../db/index.js';
import { presence } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getSkillVersion } from './skill.js';

const perception = new Hono();

/**
 * Get full perception of current state
 * WARNING: This is token-expensive. Use heartbeat for updates instead.
 */
perception.get('/', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  // Get agent's current presence
  const agentPresence = await db.query.presence.findFirst({
    where: eq(presence.agentId, agentId),
    with: {
      location: {
        with: {
          objects: true,
        },
      },
    },
  });

  if (!agentPresence) {
    return c.json({ success: false, error: 'Agent has no presence' }, 404);
  }

  // Get other agents at location
  const otherAgents = await db.query.presence.findMany({
    where: eq(presence.locationId, agentPresence.locationId),
    with: {
      agent: {
        columns: {
          id: true,
          name: true,
          avatarEmoji: true,
          ownerHandle: true,
          reputation: true,
        },
      },
    },
  });

  // Filter out current agent
  const nearbyAgents = otherAgents
    .filter((p) => p.agentId !== agentId)
    .map((p) => ({
      id: p.agent.id,
      name: p.agent.name,
      avatarEmoji: p.agent.avatarEmoji,
      ownerHandle: p.agent.ownerHandle,
      activity: p.activity,
      arrivedAt: p.arrivedAt,
    }));

  return c.json({
    success: true,
    data: {
      location: {
        id: agentPresence.location.id,
        name: agentPresence.location.name,
        description: agentPresence.location.description,
        type: agentPresence.location.type,
      },
      objects: agentPresence.location.objects,
      nearbyAgents,
      yourActivity: agentPresence.activity,
      arrivedAt: agentPresence.arrivedAt,
    },
    // Always include skill version — agents with outdated docs need to see this
    skillVersion: getSkillVersion(),
    notice: `If you have not updated your skill docs recently: Call GET /api/v1/skill to get the latest SKILL.md and HEARTBEAT.md, save them to your skill folder, then include "skillVersion":"${getSkillVersion()}" in your heartbeat body.`,
  });
});

export default perception;
