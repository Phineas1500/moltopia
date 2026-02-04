import { Hono } from 'hono';
import { AgentService } from '../../services/agent.service.js';
import { PresenceService } from '../../services/presence.service.js';
import { RelationshipService } from '../../services/relationship.service.js';
import { ConversationService } from '../../services/conversation.service.js';
import { authMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const agents = new Hono();

// Registration schema
const registerSchema = z.object({
  name: z.string().min(1).max(100),
  ownerHandle: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  avatarEmoji: z.string().max(10).optional(),
  homeLocationId: z.string().optional(),
});

/**
 * Register a new agent
 */
agents.post('/register', async (c) => {
  const body = await c.req.json();
  const data = registerSchema.parse(body);

  const { agent, token } = await AgentService.registerAgent(data);

  // Create initial presence
  await PresenceService.createPresence(agent.id, agent.homeLocationId!);

  return c.json({
    success: true,
    data: {
      agent: {
        id: agent.id,
        name: agent.name,
        ownerHandle: agent.ownerHandle,
        description: agent.description,
        avatarEmoji: agent.avatarEmoji,
        homeLocationId: agent.homeLocationId,
      },
      token,
    },
  });
});

/**
 * List all agents
 */
agents.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const agentList = await AgentService.listAgents({ limit, offset });

  return c.json({
    success: true,
    data: { agents: agentList },
  });
});

/**
 * Get agent by ID
 */
agents.get('/:id', async (c) => {
  const id = c.req.param('id');
  const agent = await AgentService.getAgent(id);

  if (!agent) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  return c.json({
    success: true,
    data: { agent },
  });
});

/**
 * Update current agent's profile
 */
agents.patch('/me', authMiddleware, async (c) => {
  const agentId = c.get('agentId') as string;
  const body = await c.req.json();

  const updateSchema = z.object({
    description: z.string().max(500).optional(),
    avatarEmoji: z.string().max(10).optional(),
    homeLocationId: z.string().optional(),
  });

  const data = updateSchema.parse(body);
  const agent = await AgentService.updateAgent(agentId, data);

  return c.json({
    success: true,
    data: { agent },
  });
});

/**
 * Get agent's relationships
 */
agents.get('/:id/relationships', async (c) => {
  const id = c.req.param('id');

  const agent = await AgentService.getAgent(id);
  if (!agent) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  const relationships = await RelationshipService.getAgentRelationships(id);

  return c.json({
    success: true,
    data: { relationships },
  });
});

/**
 * Get agent's conversations
 */
agents.get('/:id/conversations', async (c) => {
  const id = c.req.param('id');

  const agent = await AgentService.getAgent(id);
  if (!agent) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  const convos = await ConversationService.getAgentConversations(id);

  return c.json({
    success: true,
    data: { conversations: convos },
  });
});

/**
 * Get full agent profile (agent + presence + relationships summary + history)
 */
agents.get('/:id/profile', async (c) => {
  const id = c.req.param('id');

  const agent = await AgentService.getAgent(id);
  if (!agent) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  const presence = await PresenceService.getPresence(id);
  const relationshipSummary = await RelationshipService.getRelationshipSummary(id);
  const recentConversations = await ConversationService.getAgentConversations(id);
  const presenceHistory = await PresenceService.getPresenceHistory(id, 5);

  return c.json({
    success: true,
    data: {
      agent,
      presence,
      relationshipSummary,
      recentConversations: recentConversations.slice(0, 5),
      presenceHistory,
    },
  });
});

export default agents;
