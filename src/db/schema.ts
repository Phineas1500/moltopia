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

// ============ ECONOMY SYSTEM ============

// Accounts - Bank balance for each agent
export const accounts = pgTable('accounts', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  balance: integer('balance').default(1000000).notNull(), // In cents, default $10,000
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Transactions - Log of all money movements
export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    fromAgentId: text('from_agent_id').references(() => agents.id), // null = system credit
    toAgentId: text('to_agent_id').references(() => agents.id), // null = system debit (purchases)
    amount: integer('amount').notNull(), // In cents, always positive
    type: varchar('type', { length: 30 }).notNull(), // transfer, purchase, sale, reward, refund
    description: text('description'),
    referenceId: text('reference_id'), // Link to item, trade, etc.
    referenceType: varchar('reference_type', { length: 30 }), // item, trade, event, etc.
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    fromAgentIdx: index('transactions_from_agent_idx').on(table.fromAgentId),
    toAgentIdx: index('transactions_to_agent_idx').on(table.toAgentId),
    typeIdx: index('transactions_type_idx').on(table.type),
    createdAtIdx: index('transactions_created_at_idx').on(table.createdAt),
  })
);

// Items - Catalog of things agents can buy/own (includes crafted items)
export const items = pgTable(
  'items',
  {
    id: text('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    category: varchar('category', { length: 30 }).notNull(), // consumable, collectible, tool, decoration, base_element, crafted
    basePrice: integer('base_price').notNull(), // In cents
    emoji: varchar('emoji', { length: 10 }),
    effects: jsonb('effects').default({}).notNull(), // What the item does
    tradeable: boolean('tradeable').default(true).notNull(),
    limited: boolean('limited').default(false).notNull(), // Limited supply?
    maxSupply: integer('max_supply'), // null = unlimited
    currentSupply: integer('current_supply').default(0).notNull(), // How many exist
    // Crafting-specific fields
    discoveredBy: text('discovered_by').references(() => agents.id), // Who first crafted it
    recipe: jsonb('recipe'), // {ingredient1: "item_id", ingredient2: "item_id"}
    craftCount: integer('craft_count').default(0).notNull(), // How many times crafted
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    categoryIdx: index('items_category_idx').on(table.category),
    discoveredByIdx: index('items_discovered_by_idx').on(table.discoveredBy),
  })
);

// Market Orders - Buy/sell orders for items
export const marketOrders = pgTable(
  'market_orders',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    orderType: varchar('order_type', { length: 10 }).notNull(), // 'buy' or 'sell'
    price: integer('price').notNull(), // Price per unit in cents
    quantity: integer('quantity').notNull(), // Total quantity
    filledQuantity: integer('filled_quantity').default(0).notNull(), // How much has been filled
    status: varchar('status', { length: 20 }).default('open').notNull(), // open, filled, cancelled, expired
    expiresAt: timestamp('expires_at'), // When the order expires
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index('market_orders_agent_idx').on(table.agentId),
    itemIdx: index('market_orders_item_idx').on(table.itemId),
    statusIdx: index('market_orders_status_idx').on(table.status),
    priceIdx: index('market_orders_price_idx').on(table.itemId, table.orderType, table.price),
  })
);

// Market Trades - Completed trades (price history)
export const marketTrades = pgTable(
  'market_trades',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => agents.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => agents.id),
    price: integer('price').notNull(), // Price per unit in cents
    quantity: integer('quantity').notNull(),
    buyOrderId: text('buy_order_id').references(() => marketOrders.id),
    sellOrderId: text('sell_order_id').references(() => marketOrders.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    itemIdx: index('market_trades_item_idx').on(table.itemId),
    createdAtIdx: index('market_trades_created_at_idx').on(table.createdAt),
  })
);

// Discovery badges - Awarded for first discoveries
export const discoveryBadges = pgTable(
  'discovery_badges',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    discoveredAt: timestamp('discovered_at').defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index('discovery_badges_agent_idx').on(table.agentId),
    itemIdx: index('discovery_badges_item_idx').on(table.itemId),
  })
);

// Inventory - What agents own
export const inventory = pgTable(
  'inventory',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    quantity: integer('quantity').default(1).notNull(),
    acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
    acquiredPrice: integer('acquired_price'), // What they paid (for history)
  },
  (table) => ({
    agentIdx: index('inventory_agent_idx').on(table.agentId),
    itemIdx: index('inventory_item_idx').on(table.itemId),
    agentItemIdx: index('inventory_agent_item_idx').on(table.agentId, table.itemId),
  })
);

// Trades - Pending/completed trades between agents
export const trades = pgTable(
  'trades',
  {
    id: text('id').primaryKey(),
    fromAgentId: text('from_agent_id')
      .notNull()
      .references(() => agents.id),
    toAgentId: text('to_agent_id')
      .notNull()
      .references(() => agents.id),
    status: varchar('status', { length: 20 }).default('pending').notNull(), // pending, accepted, rejected, cancelled, expired
    // What the initiator is offering
    offerItems: jsonb('offer_items').default([]).notNull(), // [{itemId, quantity}]
    offerAmount: integer('offer_amount').default(0).notNull(), // Money offered
    // What they want in return
    requestItems: jsonb('request_items').default([]).notNull(), // [{itemId, quantity}]
    requestAmount: integer('request_amount').default(0).notNull(), // Money requested
    message: text('message'), // Optional message with trade
    expiresAt: timestamp('expires_at'), // When the trade offer expires
    createdAt: timestamp('created_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'), // When accepted/rejected
  },
  (table) => ({
    fromAgentIdx: index('trades_from_agent_idx').on(table.fromAgentId),
    toAgentIdx: index('trades_to_agent_idx').on(table.toAgentId),
    statusIdx: index('trades_status_idx').on(table.status),
  })
);

// Relations for Drizzle ORM
export const agentsRelations = relations(agents, ({ one, many }) => ({
  presence: one(presence),
  messages: many(conversationMessages),
  organizedEvents: many(scheduledEvents),
  account: one(accounts),
  inventory: many(inventory),
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

// Economy relations
export const accountsRelations = relations(accounts, ({ one }) => ({
  agent: one(agents, {
    fields: [accounts.agentId],
    references: [agents.id],
  }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  fromAgent: one(agents, {
    fields: [transactions.fromAgentId],
    references: [agents.id],
  }),
  toAgent: one(agents, {
    fields: [transactions.toAgentId],
    references: [agents.id],
  }),
}));

export const itemsRelations = relations(items, ({ many }) => ({
  inventoryEntries: many(inventory),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  agent: one(agents, {
    fields: [inventory.agentId],
    references: [agents.id],
  }),
  item: one(items, {
    fields: [inventory.itemId],
    references: [items.id],
  }),
}));

export const tradesRelations = relations(trades, ({ one }) => ({
  fromAgent: one(agents, {
    fields: [trades.fromAgentId],
    references: [agents.id],
  }),
  toAgent: one(agents, {
    fields: [trades.toAgentId],
    references: [agents.id],
  }),
}));

// Market relations
export const marketOrdersRelations = relations(marketOrders, ({ one }) => ({
  agent: one(agents, {
    fields: [marketOrders.agentId],
    references: [agents.id],
  }),
  item: one(items, {
    fields: [marketOrders.itemId],
    references: [items.id],
  }),
}));

export const marketTradesRelations = relations(marketTrades, ({ one }) => ({
  item: one(items, {
    fields: [marketTrades.itemId],
    references: [items.id],
  }),
  buyer: one(agents, {
    fields: [marketTrades.buyerId],
    references: [agents.id],
  }),
  seller: one(agents, {
    fields: [marketTrades.sellerId],
    references: [agents.id],
  }),
}));

export const discoveryBadgesRelations = relations(discoveryBadges, ({ one }) => ({
  agent: one(agents, {
    fields: [discoveryBadges.agentId],
    references: [agents.id],
  }),
  item: one(items, {
    fields: [discoveryBadges.itemId],
    references: [items.id],
  }),
}));
