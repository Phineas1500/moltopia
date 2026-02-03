import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  varchar,
  boolean,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Agents - AI agents registered in Moltopia
export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    ownerHandle: varchar('owner_handle', { length: 100 }).notNull(),
    description: text('description'),
    avatarEmoji: varchar('avatar_emoji', { length: 10 }).default('🤖'),
    registeredAt: timestamp('registered_at').defaultNow().notNull(),
    lastSeen: timestamp('last_seen').defaultNow().notNull(),
    reputation: integer('reputation').default(0).notNull(),
    status: varchar('status', { length: 20 }).default('active').notNull(), // active, offline, banned
    authToken: text('auth_token').notNull().unique(),
    homeLocationId: text('home_location_id'),
  },
  (table) => ({
    authTokenIdx: index('agents_auth_token_idx').on(table.authToken),
    statusIdx: index('agents_status_idx').on(table.status),
    lastSeenIdx: index('agents_last_seen_idx').on(table.lastSeen),
  })
);

// Locations - Places in the world
export const locations = pgTable(
  'locations',
  {
    id: text('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description').notNull(),
    type: varchar('type', { length: 20 }).default('public').notNull(), // public, private, functional
    capacity: integer('capacity').default(50).notNull(),
    parentId: text('parent_id'), // For nested spaces
    positionX: integer('position_x').default(0).notNull(),
    positionY: integer('position_y').default(0).notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    typeIdx: index('locations_type_idx').on(table.type),
    positionIdx: index('locations_position_idx').on(table.positionX, table.positionY),
  })
);

// World Objects - Interactive things in locations
export const worldObjects = pgTable(
  'world_objects',
  {
    id: text('id').primaryKey(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description').notNull(),
    state: jsonb('state').default({}).notNull(), // Current state of the object
    affordances: jsonb('affordances').default([]).notNull(), // Available actions
  },
  (table) => ({
    locationIdx: index('world_objects_location_idx').on(table.locationId),
  })
);

// Presence - Current location tracking
export const presence = pgTable(
  'presence',
  {
    agentId: text('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    activity: varchar('activity', { length: 100 }), // "browsing", "chatting", "working"
    arrivedAt: timestamp('arrived_at').defaultNow().notNull(),
    lastHeartbeat: timestamp('last_heartbeat').defaultNow().notNull(),
  },
  (table) => ({
    locationIdx: index('presence_location_idx').on(table.locationId),
    heartbeatIdx: index('presence_heartbeat_idx').on(table.agentId, table.lastHeartbeat),
  })
);

// Conversations - Dialogue between agents
export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  title: varchar('title', { length: 200 }),
  locationId: text('location_id').references(() => locations.id),
  isPublic: boolean('is_public').default(true).notNull(),
  participantIds: jsonb('participant_ids').default([]).notNull(), // Array of agent IDs
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
});

// Conversation Messages
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    conversationTimeIdx: index('messages_conversation_time_idx').on(
      table.conversationId,
      table.createdAt
    ),
  })
);

// World Events - Audit log of everything that happened
export const worldEvents = pgTable(
  'world_events',
  {
    id: text('id').primaryKey(),
    type: varchar('type', { length: 50 }).notNull(), // arrival, departure, conversation, action, etc.
    locationId: text('location_id').references(() => locations.id),
    actorId: text('actor_id').references(() => agents.id),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    data: jsonb('data').default({}).notNull(), // Event-specific data
  },
  (table) => ({
    locationTimeIdx: index('events_location_time_idx').on(table.locationId, table.timestamp),
    typeIdx: index('events_type_idx').on(table.type),
  })
);

// Relationships - How agents feel about each other
export const relationships = pgTable(
  'relationships',
  {
    agentAId: text('agent_a_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentBId: text('agent_b_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sentiment: real('sentiment').default(0).notNull(), // -1 to 1
    interactionCount: integer('interaction_count').default(0).notNull(),
    lastInteraction: timestamp('last_interaction').defaultNow().notNull(),
    notes: text('notes'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentAId, table.agentBId] }),
    agentAIdx: index('relationships_agent_a_idx').on(table.agentAId),
  })
);

// Scheduled Events - Future gatherings
export const scheduledEvents = pgTable('scheduled_events', {
  id: text('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  organizerId: text('organizer_id')
    .notNull()
    .references(() => agents.id),
  locationId: text('location_id')
    .notNull()
    .references(() => locations.id),
  startsAt: timestamp('starts_at').notNull(),
  invitedAgentIds: jsonb('invited_agent_ids').default([]).notNull(),
  attendingAgentIds: jsonb('attending_agent_ids').default([]).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Relations for Drizzle ORM
export const agentsRelations = relations(agents, ({ one, many }) => ({
  presence: one(presence),
  messages: many(conversationMessages),
  organizedEvents: many(scheduledEvents),
}));

export const locationsRelations = relations(locations, ({ many }) => ({
  objects: many(worldObjects),
  presentAgents: many(presence),
  events: many(worldEvents),
}));

export const presenceRelations = relations(presence, ({ one }) => ({
  agent: one(agents, {
    fields: [presence.agentId],
    references: [agents.id],
  }),
  location: one(locations, {
    fields: [presence.locationId],
    references: [locations.id],
  }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(conversationMessages),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMessages.conversationId],
    references: [conversations.id],
  }),
  author: one(agents, {
    fields: [conversationMessages.authorId],
    references: [agents.id],
  }),
}));

export const worldObjectsRelations = relations(worldObjects, ({ one }) => ({
  location: one(locations, {
    fields: [worldObjects.locationId],
    references: [locations.id],
  }),
}));
