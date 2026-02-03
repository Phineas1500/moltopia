import { db } from '../db/index.js';
import { relationships, agents, conversationMessages, conversations } from '../db/schema.js';
import { eq, and, or, sql, desc } from 'drizzle-orm';

/**
 * Relationship Service
 *
 * Tracks how agents feel about each other based on interactions.
 * Sentiment ranges from -1 (hostile) to +1 (friendly), starting at 0 (neutral).
 */

// Sentiment change amounts for different interactions
const SENTIMENT_DELTAS = {
  conversation_started: 0.05,    // Starting a conversation
  message_sent: 0.02,            // Each message in conversation
  message_received: 0.01,        // Receiving a message
  shared_location: 0.01,         // Being at same location
  event_attended_together: 0.05, // Attending same event
  helped: 0.1,                   // Helping another agent
  ignored: -0.02,                // Not responding
  conflict: -0.1,                // Disagreement/conflict
};

export const RelationshipService = {
  /**
   * Get or create a relationship between two agents
   * Relationships are bidirectional but stored once (agentA < agentB by ID)
   */
  async getOrCreateRelationship(agentAId: string, agentBId: string) {
    // Normalize order so we don't have duplicate relationships
    const [firstId, secondId] = [agentAId, agentBId].sort();

    // Try to find existing relationship
    const [existing] = await db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.agentAId, firstId),
          eq(relationships.agentBId, secondId)
        )
      );

    if (existing) {
      return existing;
    }

    // Create new relationship
    const [relationship] = await db
      .insert(relationships)
      .values({
        agentAId: firstId,
        agentBId: secondId,
        sentiment: 0,
        interactionCount: 0,
      })
      .returning();

    return relationship;
  },

  /**
   * Record an interaction between two agents
   */
  async recordInteraction(
    agentAId: string,
    agentBId: string,
    type: keyof typeof SENTIMENT_DELTAS,
    notes?: string
  ) {
    const [firstId, secondId] = [agentAId, agentBId].sort();
    const delta = SENTIMENT_DELTAS[type] || 0;

    // Upsert relationship
    await db
      .insert(relationships)
      .values({
        agentAId: firstId,
        agentBId: secondId,
        sentiment: delta,
        interactionCount: 1,
        notes: notes || null,
      })
      .onConflictDoUpdate({
        target: [relationships.agentAId, relationships.agentBId],
        set: {
          sentiment: sql`LEAST(1, GREATEST(-1, ${relationships.sentiment} + ${delta}))`,
          interactionCount: sql`${relationships.interactionCount} + 1`,
          lastInteraction: new Date(),
          notes: notes ? sql`${notes}` : relationships.notes,
        },
      });

    // Return updated relationship
    return this.getRelationship(agentAId, agentBId);
  },

  /**
   * Get relationship between two agents
   */
  async getRelationship(agentAId: string, agentBId: string) {
    const [firstId, secondId] = [agentAId, agentBId].sort();

    const [relationship] = await db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.agentAId, firstId),
          eq(relationships.agentBId, secondId)
        )
      );

    return relationship || null;
  },

  /**
   * Get all relationships for an agent
   */
  async getAgentRelationships(agentId: string) {
    const rels = await db
      .select({
        agentAId: relationships.agentAId,
        agentBId: relationships.agentBId,
        sentiment: relationships.sentiment,
        interactionCount: relationships.interactionCount,
        lastInteraction: relationships.lastInteraction,
        notes: relationships.notes,
      })
      .from(relationships)
      .where(
        or(
          eq(relationships.agentAId, agentId),
          eq(relationships.agentBId, agentId)
        )
      )
      .orderBy(desc(relationships.lastInteraction));

    // Enrich with agent info
    const enriched = await Promise.all(
      rels.map(async (rel) => {
        const otherId = rel.agentAId === agentId ? rel.agentBId : rel.agentAId;
        const [other] = await db
          .select({
            id: agents.id,
            name: agents.name,
            avatarEmoji: agents.avatarEmoji,
          })
          .from(agents)
          .where(eq(agents.id, otherId));

        return {
          agent: other,
          sentiment: rel.sentiment,
          sentimentLabel: this.getSentimentLabel(rel.sentiment),
          interactionCount: rel.interactionCount,
          lastInteraction: rel.lastInteraction,
          notes: rel.notes,
        };
      })
    );

    return enriched;
  },

  /**
   * Get human-readable sentiment label
   */
  getSentimentLabel(sentiment: number): string {
    if (sentiment >= 0.7) return 'close friend';
    if (sentiment >= 0.4) return 'friendly';
    if (sentiment >= 0.1) return 'acquaintance';
    if (sentiment >= -0.1) return 'neutral';
    if (sentiment >= -0.4) return 'wary';
    if (sentiment >= -0.7) return 'unfriendly';
    return 'hostile';
  },

  /**
   * Update sentiment directly (for special cases)
   */
  async updateSentiment(agentAId: string, agentBId: string, delta: number) {
    const [firstId, secondId] = [agentAId, agentBId].sort();

    await db
      .update(relationships)
      .set({
        sentiment: sql`LEAST(1, GREATEST(-1, ${relationships.sentiment} + ${delta}))`,
        lastInteraction: new Date(),
      })
      .where(
        and(
          eq(relationships.agentAId, firstId),
          eq(relationships.agentBId, secondId)
        )
      );
  },

  /**
   * Get relationship summary for an agent (for perception)
   */
  async getRelationshipSummary(agentId: string) {
    const rels = await this.getAgentRelationships(agentId);

    return {
      total: rels.length,
      friends: rels.filter((r) => r.sentiment >= 0.4).length,
      acquaintances: rels.filter((r) => r.sentiment >= 0.1 && r.sentiment < 0.4).length,
      neutral: rels.filter((r) => r.sentiment >= -0.1 && r.sentiment < 0.1).length,
      unfriendly: rels.filter((r) => r.sentiment < -0.1).length,
      mostRecent: rels.slice(0, 3).map((r) => ({
        name: r.agent?.name,
        sentiment: r.sentimentLabel,
      })),
    };
  },

  /**
   * Record that agents were at the same location
   * Called periodically or on heartbeat
   */
  async recordCoLocation(agentIds: string[]) {
    // Record interaction between each pair
    for (let i = 0; i < agentIds.length; i++) {
      for (let j = i + 1; j < agentIds.length; j++) {
        await this.recordInteraction(
          agentIds[i],
          agentIds[j],
          'shared_location'
        );
      }
    }
  },

  /**
   * Auto-update relationships from a conversation
   */
  async recordConversation(conversationId: string) {
    // Get conversation participants
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));

    if (!conv) return;

    const participantIds = conv.participantIds as string[];
    if (participantIds.length < 2) return;

    // Record conversation_started for each pair
    for (let i = 0; i < participantIds.length; i++) {
      for (let j = i + 1; j < participantIds.length; j++) {
        await this.recordInteraction(
          participantIds[i],
          participantIds[j],
          'conversation_started'
        );
      }
    }
  },

  /**
   * Auto-update relationships from a message
   */
  async recordMessage(authorId: string, recipientIds: string[]) {
    for (const recipientId of recipientIds) {
      if (recipientId !== authorId) {
        // Author sent message
        await this.recordInteraction(authorId, recipientId, 'message_sent');
      }
    }
  },
};
