import { db } from '../db/index.js';
import { conversations, conversationMessages, worldEvents, agents } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { PubSub } from './cache.service.js';
import { RelationshipService } from './relationship.service.js';

export const ConversationService = {
  /**
   * Create a new conversation
   */
  async createConversation(data: {
    participantIds: string[];
    locationId?: string;
    title?: string;
    isPublic?: boolean;
  }) {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [conversation] = await db
      .insert(conversations)
      .values({
        id,
        title: data.title,
        locationId: data.locationId,
        isPublic: data.isPublic !== undefined ? data.isPublic : true,
        participantIds: data.participantIds,
      })
      .returning();

    // Record relationships between all participants
    await RelationshipService.recordConversation(id);

    return conversation;
  },

  /**
   * Add message to conversation
   */
  async addMessage(conversationId: string, authorId: string, content: string) {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const [message] = await db
      .insert(conversationMessages)
      .values({
        id,
        conversationId,
        authorId,
        content,
      })
      .returning();

    // Update conversation last message time
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, conversationId));

    // Get conversation to notify participants
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    if (conversation) {
      // Get author info for broadcasting
      const [author] = await db
        .select({ name: agents.name, avatarEmoji: agents.avatarEmoji })
        .from(agents)
        .where(eq(agents.id, authorId));

      // Log as world event if in a location
      if (conversation.locationId) {
        await db.insert(worldEvents).values({
          id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'conversation',
          locationId: conversation.locationId,
          actorId: authorId,
          timestamp: new Date(),
          data: { conversationId, messagePreview: content.substring(0, 100) },
        });
      }

      // Notify via pub/sub for WebSocket clients
      const participantIds = conversation.participantIds as string[];
      await PubSub.publish(`conversation:${conversationId}`, {
        type: 'message_received',
        conversationId,
        messageId: message.id,
        authorId,
        authorName: author?.name || 'Unknown',
        content: content.substring(0, 200),
        isPublic: conversation.isPublic,
        participantIds,
      });

      // Record relationship interactions
      const otherParticipants = participantIds.filter((id) => id !== authorId);
      await RelationshipService.recordMessage(authorId, otherParticipants);
    }

    return message;
  },

  /**
   * Get conversation messages
   */
  async getMessages(conversationId: string, params: { limit?: number; offset?: number }) {
    const { limit = 50, offset = 0 } = params;

    return db.query.conversationMessages.findMany({
      where: eq(conversationMessages.conversationId, conversationId),
      limit,
      offset,
      orderBy: (messages, { desc }) => [desc(messages.createdAt)],
      with: {
        author: {
          columns: {
            id: true,
            name: true,
            avatarEmoji: true,
          },
        },
      },
    });
  },

  /**
   * Get conversations for an agent
   */
  async getAgentConversations(agentId: string) {
    return db.query.conversations.findMany({
      where: sql`${conversations.participantIds}::jsonb ? ${agentId}`,
      orderBy: (conversations, { desc }) => [desc(conversations.lastMessageAt)],
    });
  },

  /**
   * Get conversation by ID
   */
  async getConversation(id: string) {
    return db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });
  },
};
