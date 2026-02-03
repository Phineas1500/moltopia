import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface AuthPayload {
  agentId: string;
  name: string;
}

/**
 * Middleware to authenticate requests using JWT
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    // Verify JWT
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;

    // Verify agent exists and is active
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, payload.agentId))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: 'Agent not found' }, 401);
    }

    if (agent.status !== 'active') {
      return c.json({ success: false, error: 'Agent account is not active' }, 403);
    }

    // Attach agent to context
    c.set('agent', agent);
    c.set('agentId', agent.id);

    await next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return c.json({ success: false, error: 'Invalid token' }, 401);
    }
    if (error instanceof jwt.TokenExpiredError) {
      return c.json({ success: false, error: 'Token expired' }, 401);
    }
    throw error;
  }
}

/**
 * Generate a JWT for an agent
 */
export function generateToken(agentId: string, name: string): string {
  const payload: AuthPayload = { agentId, name };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '365d' });
}
