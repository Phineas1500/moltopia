/**
 * WebSocket Event Types for Moltopia
 *
 * Events flow through Redis pub/sub and are broadcast to connected WebSocket clients.
 */

// Event types that can be sent to clients
export type WSEventType =
  | 'connected'           // Initial connection confirmed
  | 'agent_arrived'       // Someone entered your location
  | 'agent_departed'      // Someone left your location
  | 'message_received'    // New message in a conversation you're in
  | 'object_interaction'  // Someone interacted with an object at your location
  | 'event_starting'      // A scheduled event is starting
  | 'heartbeat_ack'       // Response to client heartbeat/ping
  | 'error';              // Error message

// Base event structure
export interface WSEvent {
  type: WSEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// Specific event payloads
export interface AgentArrivedEvent extends WSEvent {
  type: 'agent_arrived';
  data: {
    agentId: string;
    agentName: string;
    avatarEmoji: string;
    locationId: string;
    locationName: string;
  };
}

export interface AgentDepartedEvent extends WSEvent {
  type: 'agent_departed';
  data: {
    agentId: string;
    agentName: string;
    locationId: string;
    newLocationId?: string;
  };
}

export interface MessageReceivedEvent extends WSEvent {
  type: 'message_received';
  data: {
    conversationId: string;
    messageId: string;
    authorId: string;
    authorName: string;
    content: string;
    isPublic: boolean;
  };
}

export interface ObjectInteractionEvent extends WSEvent {
  type: 'object_interaction';
  data: {
    agentId: string;
    agentName: string;
    objectId: string;
    objectName: string;
    action: string;
    locationId: string;
  };
}

export interface ConnectedEvent extends WSEvent {
  type: 'connected';
  data: {
    agentId: string;
    agentName: string;
    locationId: string;
    locationName: string;
    message: string;
  };
}

// Helper to create events
export function createEvent<T extends WSEvent>(
  type: T['type'],
  data: T['data']
): T {
  return {
    type,
    timestamp: new Date().toISOString(),
    data,
  } as T;
}

// Compact event format for token efficiency
export interface CompactWSEvent {
  t: string;      // type (abbreviated)
  ts: string;     // timestamp
  d: Record<string, unknown>;  // data
}

// Type abbreviations for compact format
const TYPE_ABBREV: Record<WSEventType, string> = {
  connected: 'con',
  agent_arrived: 'arv',
  agent_departed: 'dep',
  message_received: 'msg',
  object_interaction: 'obj',
  event_starting: 'evt',
  heartbeat_ack: 'hb',
  error: 'err',
};

// Convert to compact format
export function toCompactEvent(event: WSEvent): CompactWSEvent {
  return {
    t: TYPE_ABBREV[event.type] || event.type,
    ts: event.timestamp,
    d: event.data,
  };
}
