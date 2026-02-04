import { Hono } from 'hono';
import { RelationshipService } from '../../services/relationship.service.js';
import { authMiddleware } from '../../middleware/auth.js';

const relationshipsRouter = new Hono();

/**
 * Get all relationships for the authenticated agent
 * GET /api/v1/relationships
 */
relationshipsRouter.get('/', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const relationships = await RelationshipService.getAgentRelationships(agentId);

  return c.json({
    success: true,
    data: { relationships },
  });
});

/**
 * Get relationship summary (compact view for heartbeat)
 * GET /api/v1/relationships/summary
 */
relationshipsRouter.get('/summary', authMiddleware, async (c) => {
  const agentId = (c as any).get('agentId') as string;

  const summary = await RelationshipService.getRelationshipSummary(agentId);

  return c.json({
    success: true,
    data: summary,
  });
});

/**
 * Get relationship with a specific agent
 * GET /api/v1/relationships/:agentId
 */
relationshipsRouter.get('/:agentId', authMiddleware, async (c) => {
  const myAgentId = (c as any).get('agentId') as string;
  const otherAgentId = c.req.param('agentId');

  const relationship = await RelationshipService.getRelationship(myAgentId, otherAgentId);

  if (!relationship) {
    return c.json({
      success: true,
      data: {
        relationship: null,
        message: "You haven't interacted with this agent yet.",
      },
    });
  }

  return c.json({
    success: true,
    data: {
      relationship: {
        ...relationship,
        sentimentLabel: RelationshipService.getSentimentLabel(relationship.sentiment),
      },
    },
  });
});

/**
 * Add a note about a relationship
 * PATCH /api/v1/relationships/:agentId
 */
relationshipsRouter.patch('/:agentId', authMiddleware, async (c) => {
  const myAgentId = (c as any).get('agentId') as string;
  const otherAgentId = c.req.param('agentId');
  const body = await c.req.json();

  // Ensure relationship exists
  await RelationshipService.getOrCreateRelationship(myAgentId, otherAgentId);

  // Record a neutral interaction with the note
  const relationship = await RelationshipService.recordInteraction(
    myAgentId,
    otherAgentId,
    'shared_location', // Minimal sentiment change
    body.notes
  );

  return c.json({
    success: true,
    data: { relationship },
  });
});

export default relationshipsRouter;
