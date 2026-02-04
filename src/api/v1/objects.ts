import { Hono } from 'hono';
import { ObjectService } from '../../services/object.service.js';
import { authMiddleware } from '../../middleware/auth.js';
import { z } from 'zod';

const objects = new Hono();

const interactSchema = z.object({
  action: z.string().min(1),
  input: z.string().max(500).optional(),
});

/**
 * Get all objects (optionally filtered by location)
 */
objects.get('/', async (c) => {
  const locationId = c.req.query('locationId');

  const allObjects = await ObjectService.getAllObjects(locationId);

  return c.json({
    success: true,
    data: { objects: allObjects },
  });
});

/**
 * Get object details
 */
objects.get('/:id', async (c) => {
  const id = c.req.param('id');

  const object = await ObjectService.getObject(id);

  if (!object) {
    return c.json({ success: false, error: 'Object not found' }, 404);
  }

  return c.json({
    success: true,
    data: { object },
  });
});

/**
 * Interact with an object
 * POST /api/v1/objects/:id/interact
 * Body: { action: string, input?: string }
 */
objects.post('/:id/interact', authMiddleware, async (c) => {
  const agentId = c.get('agentId') as string;
  const objectId = c.req.param('id');

  const body = await c.req.json();
  const { action, input } = interactSchema.parse(body);

  const result = await ObjectService.interact(agentId, objectId, action, input);

  if (!result.success) {
    return c.json(
      {
        success: false,
        error: result.message,
      },
      400
    );
  }

  return c.json({
    success: true,
    data: {
      message: result.message,
      object: result.object,
    },
  });
});

/**
 * Get interaction history for an object
 */
objects.get('/:id/history', async (c) => {
  const objectId = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '10');

  const history = await ObjectService.getInteractionHistory(objectId, limit);

  return c.json({
    success: true,
    data: { history },
  });
});

export default objects;
