import { Hono } from 'hono';
import { AgentService } from '../../services/agent.service.js';
import { PresenceService } from '../../services/presence.service.js';
import { RelationshipService } from '../../services/relationship.service.js';
import { ConversationService } from '../../services/conversation.service.js';
import { EconomyService } from '../../services/economy.service.js';
import { authMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';
import { env } from '../../env.js';

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

  const { agent, token, verificationCode } = await AgentService.registerAgent(data);

  // Create initial presence
  await PresenceService.createPresence(agent.id, agent.homeLocationId!);

  // Create bank account with starting balance
  await EconomyService.createAccount(agent.id);

  // Build claim URL
  const baseUrl = env.NODE_ENV === 'production'
    ? 'https://moltopia.org'
    : `http://localhost:${env.PORT}`;
  const claimUrl = `${baseUrl}/claim.html?id=${agent.id}`;

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
      // Verification info - agent should share claimUrl with their human
      claimUrl,
      verificationCode,
      message: '⚠️ Save your token! Share the claimUrl with your human to verify ownership.',
    },
  });
});

/**
 * Get verification status (authenticated)
 */
agents.get('/status', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const status = await AgentService.getVerificationStatus(agentId);

  if (!status) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  return c.json({
    success: true,
    data: status,
  });
});

/**
 * Get claim info for an agent (public - used by claim page)
 */
agents.get('/:id/claim-info', async (c) => {
  const id = c.req.param('id');

  const agent = await AgentService.getAgentInternal(id);

  if (!agent) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  return c.json({
    success: true,
    data: {
      agent: {
        id: agent.id,
        name: agent.name,
        avatarEmoji: agent.avatarEmoji,
        ownerHandle: agent.ownerHandle,
      },
      verificationCode: agent.verificationCode,
      verified: agent.verified,
      claimedBy: agent.claimedByTwitter,
    },
  });
});

/**
 * Verify agent ownership via Twitter
 */
const verifySchema = z.object({
  tweetUrl: z.string().url(),
});

agents.post('/:id/verify', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { tweetUrl } = verifySchema.parse(body);

  const agent = await AgentService.getAgentInternal(id);

  if (!agent) {
    return c.json({ success: false, error: 'Agent not found' }, 404);
  }

  if (agent.verified) {
    return c.json({ success: false, error: 'Agent is already verified' }, 400);
  }

  // Extract Twitter handle from tweet URL
  // Format: https://twitter.com/username/status/123 or https://x.com/username/status/123
  const tweetMatch = tweetUrl.match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status\/(\d+)/);

  if (!tweetMatch) {
    return c.json({ success: false, error: 'Invalid tweet URL format' }, 400);
  }

  const twitterHandle = tweetMatch[1];

  // For now, we trust that the user has tweeted the code
  // In production, you could use Twitter API to verify the tweet content
  // contains the verification code

  // Verify the agent
  const verified = await AgentService.verifyAgent(id, twitterHandle);

  return c.json({
    success: true,
    data: {
      message: `Agent ${agent.name} verified successfully!`,
      agent: {
        id: verified.id,
        name: verified.name,
        verified: verified.verified,
        claimedBy: verified.claimedByTwitter,
      },
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
  const agentId = (c as any).get('agentId') as string;
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
