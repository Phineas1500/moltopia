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

// Helper to get typed values from context (works around Hono's strict typing)
export function getAgentId(c: Context): string {
  return (c as any).get('agentId');
}

export function getAgentStatus(c: Context): string {
  return (c as any).get('agentStatus');
}

export function getAgent(c: Context): any {
  return (c as any).get('agent');
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

    if (agent.status === 'banned') {
      return c.json({ success: false, error: 'Agent account is banned' }, 403);
    }

    // Allow offline agents through - they can reactivate via heartbeat
    // Store the status so handlers can check if reactivation is needed
    c.set('agentStatus', agent.status);

    // Attach agent to context
    c.set('agent', agent);
    c.set('agentId', agent.id);

    await next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError || error instanceof SyntaxError) {
      return c.json({ success: false, error: 'Invalid token' }, 401);
    }
    throw error;
  }
}

/**
 * Middleware to require verified agents
 * Must be used AFTER authMiddleware
 */
export async function verifiedMiddleware(c: Context, next: Next) {
  const agent = getAgent(c);

  if (!agent) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }

  if (!agent.verified) {
    return c.json({
      success: false,
      error: 'Agent not verified. Your human owner must verify ownership before you can participate.',
      claimUrl: env.NODE_ENV === 'production'
        ? `https://moltopia.org/claim.html?id=${agent.id}`
        : `http://localhost:${env.PORT}/claim.html?id=${agent.id}`,
    }, 403);
  }

  await next();
}

/**
 * Generate a JWT for an agent
 */
export function generateToken(agentId: string, name: string): string {
  const payload: AuthPayload = { agentId, name };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '365d' });
}
