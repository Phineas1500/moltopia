import { Context, Next } from 'hono';
import { countJSONTokens } from '../utils/token-counter.js';
import { env } from '../env.js';

/**
 * Key abbreviation map for compact mode
 * Transforms verbose JSON keys into short versions
 */
const KEY_MAP: Record<string, string> = {
  // Meta
  success: 'ok',
  data: 'd',
  error: 'err',
  message: 'msg',

  // Agent fields
  agent: 'a',
  agents: 'as',
  agent_id: 'ai',
  name: 'n',
  description: 'desc',
  avatar_emoji: 'av',
  owner_handle: 'oh',
  status: 's',
  reputation: 'rep',
  last_seen: 'ls',

  // Location fields
  location: 'l',
  locations: 'ls',
  location_id: 'li',
  type: 't',
  capacity: 'cap',
  position_x: 'x',
  position_y: 'y',

  // Presence fields
  activity: 'act',
  arrived_at: 'arr',
  last_heartbeat: 'hb',

  // Conversation fields
  conversation: 'c',
  conversations: 'cs',
  conversation_id: 'ci',
  content: 'txt',
  author_id: 'aid',
  created_at: 'at',

  // Delta fields
  delta: 'dlt',
  arrived: 'arv',
  departed: 'dep',
  messages: 'msgs',
  events: 'evs',
  location_changed: 'lc',

  // Common
  id: 'i',
  timestamp: 'ts',
};

/**
 * Recursively transform keys in an object to their compact versions
 */
function compactObject(obj: any): any {
  if (obj === null || obj === undefined) {
    return undefined; // Remove null/undefined values
  }

  if (Array.isArray(obj)) {
    return obj.map(compactObject).filter((item) => item !== undefined);
  }

  if (typeof obj === 'object') {
    const result: any = {};

    for (const [key, value] of Object.entries(obj)) {
      // Skip null/undefined values
      if (value === null || value === undefined) {
        continue;
      }

      // Convert booleans to numbers
      let transformedValue = value;
      if (typeof value === 'boolean') {
        transformedValue = value ? 1 : 0;
      } else {
        transformedValue = compactObject(value);
      }

      // Skip if recursion returned undefined
      if (transformedValue === undefined) {
        continue;
      }

      // Use abbreviated key or original
      const compactKey = KEY_MAP[key] || key;
      result[compactKey] = transformedValue;
    }

    return result;
  }

  return obj;
}

/**
 * Middleware to transform responses to compact format
 * Activated by ?compact=true query parameter
 */
export async function compactMiddleware(c: Context, next: Next) {
  // Check if compact mode is requested
  const compact = c.req.query('compact') === 'true';

  if (!compact) {
    await next();
    return;
  }

  // Intercept the json() method on Context
  const originalJson = c.json.bind(c);

  (c as any).json = function (object: any, status?: number) {
    // Transform to compact format
    const compactBody = compactObject(object);

    // Count tokens if metrics are enabled
    let tokenCount = 0;
    if (env.ENABLE_TOKEN_METRICS) {
      tokenCount = countJSONTokens(compactBody);
    }

    // Call original json method with compact body
    const response = (originalJson as any)(compactBody, status);

    // Add token count header if enabled
    if (env.ENABLE_TOKEN_METRICS) {
      response.headers.set('X-Token-Count', tokenCount.toString());
    }

    return response;
  };

  await next();
}
