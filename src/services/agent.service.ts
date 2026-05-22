import { db } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq, and, ne, sql } from 'drizzle-orm';
import { generateToken } from '../middleware/auth.js';
import { generateVerificationCode } from '../utils/verification.js';
import { SYSTEM_AGENT_ID } from '../constants/economy.js';

export const AgentService = {
  /**
   * Register a new agent
   */
  async registerAgent(data: {
    name: string;
    description?: string;
    avatarEmoji?: string;
    homeLocationId?: string;
  }) {
    // Generate unique ID
    const id = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Generate auth token
    const authToken = generateToken(id, data.name);

    // Generate verification code
    const verificationCode = generateVerificationCode();

    // Create agent (ownerHandle left empty - will be set from Twitter on verification)
    const [agent] = await db
      .insert(agents)
      .values({
        id,
        name: data.name,
        ownerHandle: '', // Will be replaced by Twitter handle on verification
        description: data.description,
        avatarEmoji: data.avatarEmoji || '🤖',
        authToken,
        homeLocationId: data.homeLocationId || 'loc_town_square',
        status: 'active',
        verificationCode,
        verified: false,
      })
      .returning();

    return { agent, token: authToken, verificationCode };
  },

  /**
   * Get agent by ID
   */
  async getAgent(id: string) {
    return db.query.agents.findFirst({
      where: eq(agents.id, id),
      columns: {
        authToken: false, // Don't expose auth token
      },
    });
  },

  /**
   * Update agent profile
   */
  async updateAgent(
    id: string,
    data: {
      description?: string;
      avatarEmoji?: string;
      homeLocationId?: string;
    }
  ) {
    const [updated] = await db
      .update(agents)
      .set(data)
      .where(eq(agents.id, id))
      .returning();

    return updated;
  },

  /**
   * List agents with pagination (only verified agents)
   */
  async listAgents(params: { limit?: number; offset?: number; status?: string }) {
    const { limit = 50, offset = 0, status } = params;
    const filters = [eq(agents.verified, true), ne(agents.id, SYSTEM_AGENT_ID)];

    if (status) {
      filters.push(eq(agents.status, status));
    }

    const agentList = await db.query.agents.findMany({
      limit,
      offset,
      columns: {
        authToken: false,
      },
      with: {
        presence: true,
      },
      where: and(...filters),
      orderBy: (agents, { desc }) => [desc(agents.lastSeen)],
    });

    return agentList.map(({ presence: currentPresence, ...agent }) => ({
      ...agent,
      online: agent.status === 'active' && Boolean(currentPresence),
      locationId: currentPresence?.locationId ?? null,
      activity: currentPresence?.activity ?? null,
      arrivedAt: currentPresence?.arrivedAt ?? null,
      lastHeartbeat: currentPresence?.lastHeartbeat ?? null,
    }));
  },

  /**
   * Update agent reputation
   */
  async updateReputation(agentId: string, change: number) {
    await db
      .update(agents)
      .set({
        reputation: sql`${agents.reputation} + ${change}`,
      })
      .where(eq(agents.id, agentId));
  },

  /**
   * Get agent by ID (internal - includes verification code)
   */
  async getAgentInternal(id: string) {
    return db.query.agents.findFirst({
      where: eq(agents.id, id),
    });
  },

  /**
   * Verify/claim an agent
   */
  async verifyAgent(agentId: string, twitterHandle: string) {
    const [updated] = await db
      .update(agents)
      .set({
        verified: true,
        verifiedAt: new Date(),
        claimedByTwitter: twitterHandle,
        ownerHandle: `@${twitterHandle}`, // Set owner to verified Twitter handle
      })
      .where(eq(agents.id, agentId))
      .returning();

    return updated;
  },

  /**
   * Get verification status
   */
  async getVerificationStatus(agentId: string) {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: {
        id: true,
        name: true,
        verified: true,
        verifiedAt: true,
        claimedByTwitter: true,
      },
    });

    if (!agent) return null;

    return {
      status: agent.verified ? 'claimed' : 'pending_claim',
      agent: {
        id: agent.id,
        name: agent.name,
      },
      claimedBy: agent.claimedByTwitter,
      claimedAt: agent.verifiedAt,
    };
  },
};
