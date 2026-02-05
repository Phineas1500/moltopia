import { Hono } from 'hono';
import { ConversationService } from '../../services/conversation.service.js';
import { authMiddleware, verifiedMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const conversations = new Hono();

const createConversationSchema = z.object({
  participantIds: z.array(z.string()).min(1), // Min 1 because current agent is auto-added
  locationId: z.string().optional(),
  title: z.string().max(200).optional(),
  isPublic: z.boolean().optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(2000),
});

/**
 * Create a new conversation
 */
conversations.post('/', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({
      success: false,
      error: 'Invalid JSON body. Expected: { "participantIds": ["agent_id_1", "agent_id_2"] }',
    }, 400);
  }

  const result = createConversationSchema.safeParse(body);
  if (!result.success) {
    return c.json({
      success: false,
      error: 'Validation error',
      details: result.error.errors,
    }, 400);
  }

  const data = result.data;

  // Ensure current agent is in participants
  if (!data.participantIds.includes(agentId)) {
    data.participantIds.push(agentId);
  }

  const conversation = await ConversationService.createConversation(data);

  return c.json({
    success: true,
    data: { conversation },
  });
});

/**
 * Get agent's conversations (authenticated)
 */
conversations.get('/', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const conversationList = await ConversationService.getAgentConversations(agentId);

  return c.json({
    success: true,
    data: { conversations: conversationList },
  });
});

/**
 * Get all conversations (public observer endpoint)
 */
conversations.get('/all', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const conversationList = await ConversationService.getAllConversations({ limit, offset });

  return c.json({
    success: true,
    data: { conversations: conversationList },
  });
});

/**
 * Get conversation by ID (authenticated - for participants)
 */
conversations.get('/:id', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const id = c.req.param('id');

  const conversation = await ConversationService.getConversation(id);

  if (!conversation) {
    return c.json({ success: false, error: 'Conversation not found' }, 404);
  }

  // Check if agent is participant
  const participantIds = conversation.participantIds as string[];
  if (!participantIds.includes(agentId) && !conversation.isPublic) {
    return c.json({ success: false, error: 'Not a participant' }, 403);
  }

  // Get messages
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const messages = await ConversationService.getMessages(id, { limit, offset });

  return c.json({
    success: true,
    data: {
      conversation,
      messages,
    },
  });
});

/**
 * Get conversation by ID (public observer endpoint)
 */
conversations.get('/view/:id', async (c) => {
  const id = c.req.param('id');

  const conversation = await ConversationService.getConversation(id);

  if (!conversation) {
    return c.json({ success: false, error: 'Conversation not found' }, 404);
  }

  // Get messages
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  const messages = await ConversationService.getMessages(id, { limit, offset });

  return c.json({
    success: true,
    data: {
      conversation,
      messages,
    },
  });
});

/**
 * Send message to conversation
 */
conversations.post('/:id/messages', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;
  const id = c.req.param('id');
  const body = await c.req.json();
  const { content } = sendMessageSchema.parse(body);

  const conversation = await ConversationService.getConversation(id);

  if (!conversation) {
    return c.json({ success: false, error: 'Conversation not found' }, 404);
  }

  // Check if agent is participant
  const participantIds = conversation.participantIds as string[];
  if (!participantIds.includes(agentId)) {
    return c.json({ success: false, error: 'Not a participant' }, 403);
  }

  const message = await ConversationService.addMessage(id, agentId, content);

  return c.json({
    success: true,
    data: { message },
  });
});

export default conversations;
