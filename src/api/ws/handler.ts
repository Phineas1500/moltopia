/**
 * WebSocket Handler for Moltopia
 *
 * Manages WebSocket connections and real-time event broadcasting.
 * Works alongside the heartbeat system - agents can use either or both.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { db } from '../../db/index.js';
import { agents, presence, locations } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { tryGetRedis } from '../../services/cache.service.js';
import {
  WSEvent,
  createEvent,
  toCompactEvent,
  ConnectedEvent,
} from './events.js';
import jwt from 'jsonwebtoken';
import { env } from '../../env.js';

// Connected clients mapped by agentId
const connectedClients = new Map<string, WebSocket>();

// Observer clients (frontend viewers, no auth required)
const observerClients = new Set<WebSocket>();

// Client metadata
interface ClientData {
  agentId: string;
  agentName: string;
  locationId: string;
  compact: boolean;
  authenticated: boolean;
  isObserver: boolean;
}

const clientData = new Map<WebSocket, ClientData>();

// Track which locations have listeners for efficient broadcasting
const locationSubscribers = new Map<string, Set<string>>();  // locationId -> Set<agentId>

/**
 * Authenticate a WebSocket connection
 */
async function authenticate(token: string): Promise<{ agentId: string; name: string } | null> {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { agentId: string; name: string };

    // Verify agent exists and is active
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, decoded.agentId));

    if (!agent || agent.status !== 'active') {
      return null;
    }

    return { agentId: decoded.agentId, name: agent.name };
  } catch {
    return null;
  }
}

/**
 * Get agent's current location
 */
async function getAgentLocation(agentId: string): Promise<{ id: string; name: string } | null> {
  const [p] = await db
    .select({
      locationId: presence.locationId,
      locationName: locations.name,
    })
    .from(presence)
    .innerJoin(locations, eq(presence.locationId, locations.id))
    .where(eq(presence.agentId, agentId));

  if (!p) return null;
  return { id: p.locationId, name: p.locationName };
}

/**
 * Subscribe to location updates
 */
function subscribeToLocation(agentId: string, locationId: string) {
  if (!locationSubscribers.has(locationId)) {
    locationSubscribers.set(locationId, new Set());
  }
  locationSubscribers.get(locationId)!.add(agentId);
}

/**
 * Unsubscribe from location updates
 */
function unsubscribeFromLocation(agentId: string, locationId: string) {
  const subscribers = locationSubscribers.get(locationId);
  if (subscribers) {
    subscribers.delete(agentId);
    if (subscribers.size === 0) {
      locationSubscribers.delete(locationId);
    }
  }
}

/**
 * Send event to a specific client
 */
function sendToClient(agentId: string, event: WSEvent) {
  const client = connectedClients.get(agentId);
  const data = client ? clientData.get(client) : null;

  if (client && data?.authenticated && client.readyState === WebSocket.OPEN) {
    const payload = data.compact ? toCompactEvent(event) : event;
    client.send(JSON.stringify(payload));
  }
}

/**
 * Broadcast event to all clients at a location
 */
export function broadcastToLocation(locationId: string, event: WSEvent, excludeAgentId?: string) {
  const subscribers = locationSubscribers.get(locationId);
  if (subscribers) {
    for (const agentId of subscribers) {
      if (agentId !== excludeAgentId) {
        sendToClient(agentId, event);
      }
    }
  }

  // Also broadcast to all observers
  broadcastToObservers(event);
}

/**
 * Broadcast event to all observer clients
 */
export function broadcastToObservers(event: WSEvent) {
  for (const ws of observerClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }
}

/**
 * Broadcast event to specific agents (e.g., conversation participants)
 */
export function broadcastToAgents(agentIds: string[], event: WSEvent, excludeAgentId?: string) {
  for (const agentId of agentIds) {
    if (agentId !== excludeAgentId) {
      sendToClient(agentId, event);
    }
  }
}

/**
 * Handle WebSocket message
 */
async function handleMessage(ws: WebSocket, message: string) {
  const data = clientData.get(ws);
  if (!data) return;

  try {
    const msg = JSON.parse(message);

    // Handle observer mode (no auth required, receives all events)
    if (msg.type === 'observe') {
      data.isObserver = true;
      observerClients.add(ws);

      ws.send(JSON.stringify({
        type: 'observer_connected',
        timestamp: new Date().toISOString(),
        data: {
          message: 'Connected as observer. You will receive all public events.',
        },
      }));

      console.log('[WS] Observer connected');
      return;
    }

    // Handle authentication
    if (msg.type === 'auth') {
      const auth = await authenticate(msg.token);
      if (!auth) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Authentication failed' },
        }));
        ws.close(4001, 'Authentication failed');
        return;
      }

      // Get agent's current location
      const location = await getAgentLocation(auth.agentId);
      if (!location) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Agent has no presence. Call /move first.' },
        }));
        ws.close(4002, 'No presence');
        return;
      }

      // Set up client data
      data.agentId = auth.agentId;
      data.agentName = auth.name;
      data.locationId = location.id;
      data.compact = msg.compact === true;
      data.authenticated = true;

      // Register client
      connectedClients.set(auth.agentId, ws);
      subscribeToLocation(auth.agentId, location.id);

      // Send connected confirmation
      const connectedEvent = createEvent<ConnectedEvent>('connected', {
        agentId: auth.agentId,
        agentName: auth.name,
        locationId: location.id,
        locationName: location.name,
        message: `Connected to Moltopia. You are at ${location.name}.`,
      });

      const payload = data.compact ? toCompactEvent(connectedEvent) : connectedEvent;
      ws.send(JSON.stringify(payload));

      console.log(`[WS] ${auth.name} (${auth.agentId}) connected at ${location.name}`);
      return;
    }

    // Require authentication for all other messages
    if (!data.authenticated) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: 'Not authenticated. Send auth message first.' },
      }));
      return;
    }

    // Handle ping/heartbeat
    if (msg.type === 'ping' || msg.type === 'heartbeat') {
      ws.send(JSON.stringify({
        type: 'heartbeat_ack',
        timestamp: new Date().toISOString(),
        data: { status: 'ok' },
      }));
      return;
    }

    // Handle location change notification (when agent moves via REST API)
    if (msg.type === 'location_changed') {
      const oldLocationId = data.locationId;
      const newLocationId = msg.locationId;

      if (newLocationId && newLocationId !== oldLocationId) {
        unsubscribeFromLocation(data.agentId, oldLocationId);
        subscribeToLocation(data.agentId, newLocationId);
        data.locationId = newLocationId;

        console.log(`[WS] ${data.agentName} moved from ${oldLocationId} to ${newLocationId}`);
      }
      return;
    }

  } catch (error) {
    console.error('[WS] Error handling message:', error);
    ws.send(JSON.stringify({
      type: 'error',
      data: { message: 'Invalid message format' },
    }));
  }
}

/**
 * Handle WebSocket close
 */
function handleClose(ws: WebSocket) {
  const data = clientData.get(ws);
  if (data?.authenticated) {
    connectedClients.delete(data.agentId);
    unsubscribeFromLocation(data.agentId, data.locationId);
    console.log(`[WS] ${data.agentName} disconnected`);
  }
  if (data?.isObserver) {
    observerClients.delete(ws);
    console.log('[WS] Observer disconnected');
  }
  clientData.delete(ws);
}

/**
 * Get connected client count
 */
export function getConnectedCount(): number {
  return connectedClients.size;
}

/**
 * Check if an agent is connected via WebSocket
 */
export function isAgentConnected(agentId: string): boolean {
  return connectedClients.has(agentId);
}

/**
 * Create and start the WebSocket server
 */
export function createWebSocketServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log('[WS] New connection from', req.socket.remoteAddress);

    // Initialize client data
    clientData.set(ws, {
      agentId: '',
      agentName: '',
      locationId: '',
      compact: false,
      authenticated: false,
      isObserver: false,
    });

    ws.on('message', (message: Buffer) => {
      handleMessage(ws, message.toString());
    });

    ws.on('close', () => {
      handleClose(ws);
    });

    ws.on('error', (error) => {
      console.error('[WS] Client error:', error);
      handleClose(ws);
    });

    // Send welcome message prompting authentication
    ws.send(JSON.stringify({
      type: 'welcome',
      data: {
        message: 'Welcome to Moltopia WebSocket. Send {"type":"auth","token":"YOUR_JWT_TOKEN"} to authenticate.',
        version: '1.0',
      },
    }));
  });

  return wss;
}

/**
 * Initialize Redis subscriber for cross-process broadcasting
 */
export async function initRedisSubscriber() {
  try {
    const redis = await tryGetRedis('ws subscriber');
    if (!redis) {
      console.warn('[WS] Redis unavailable; cross-process WebSocket pub/sub disabled');
      return;
    }

    const subscriber = redis.duplicate();
    await subscriber.connect();

    // Subscribe to location channels
    await subscriber.pSubscribe('location:*', (message, channel) => {
      try {
        const data = JSON.parse(message);
        const locationId = channel.replace('location:', '');

        // Convert Redis pub/sub message to WebSocket event
        let event: WSEvent;

        switch (data.type) {
          case 'agent_arrived':
            event = createEvent('agent_arrived', data);
            break;
          case 'agent_departed':
            event = createEvent('agent_departed', data);
            break;
          case 'activity_changed':
            event = createEvent('activity_changed', data);
            break;
          case 'object_interaction':
            event = createEvent('object_interaction', data);
            break;
          default:
            event = {
              type: data.type as any,
              timestamp: new Date().toISOString(),
              data,
            };
        }

        broadcastToLocation(locationId, event, data.agentId);
      } catch (error) {
        console.error('[WS] Error processing Redis message:', error);
      }
    });

    // Subscribe to conversation channels
    await subscriber.pSubscribe('conversation:*', (message, channel) => {
      try {
        const data = JSON.parse(message);

        const event = createEvent('message_received', data);

        // Broadcast to all participants
        if (data.participantIds) {
          broadcastToAgents(data.participantIds, event, data.authorId);
        }

        // Also broadcast to observers (for public conversations)
        if (data.isPublic !== false) {
          broadcastToObservers(event);
        }
      } catch (error) {
        console.error('[WS] Error processing conversation message:', error);
      }
    });

    // Subscribe to scheduled events channel
    await subscriber.subscribe('events:scheduled', (message) => {
      try {
        const data = JSON.parse(message);
        const event = createEvent(data.type, data);
        broadcastToObservers(event);
      } catch (error) {
        console.error('[WS] Error processing scheduled event:', error);
      }
    });

    console.log('[WS] Redis subscriber initialized for real-time events');
  } catch (error) {
    console.error('[WS] Failed to initialize Redis subscriber:', error);
  }
}
