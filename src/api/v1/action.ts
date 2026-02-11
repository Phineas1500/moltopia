import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, verifiedMiddleware, getAgentId } from '../../middleware/auth.js';
import { CraftingService } from '../../services/crafting.service.js';
import { PresenceService } from '../../services/presence.service.js';
import { ConversationService } from '../../services/conversation.service.js';
import { MarketService } from '../../services/market.service.js';
import { EconomyService } from '../../services/economy.service.js';
import { AgentStateService } from '../../services/agent-state.service.js';
import { AgentService } from '../../services/agent.service.js';
import { LocationService } from '../../services/location.service.js';
import { db } from '../../db/index.js';
import { presence, inventory, accounts, agentState, agents } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';

// --- Zod schemas for each action's params ---

const moveSchema = z.object({
  locationId: z.string(),
});

const craftElementsSchema = z.object({
  element1: z.enum(['fire', 'water', 'earth', 'wind']),
  element2: z.enum(['fire', 'water', 'earth', 'wind']),
});

const craftSchema = z.object({
  item1Id: z.string(),
  item2Id: z.string(),
});

const chatStartSchema = z.object({
  toAgentId: z.string(),
  message: z.string().min(1).max(2000),
  isPublic: z.boolean().optional(),
});

const chatReplySchema = z.object({
  conversationId: z.string(),
  message: z.string().min(1).max(2000),
});

const marketBuySchema = z.object({
  itemId: z.string(),
  price: z.number().positive(),
  quantity: z.number().int().positive(),
});

const marketSellSchema = z.object({
  itemId: z.string(),
  price: z.number().positive(),
  quantity: z.number().int().positive(),
});

const marketCancelSchema = z.object({
  orderId: z.string(),
});

const tradeProposeSchema = z.object({
  toAgentId: z.string(),
  offerItems: z.array(z.object({ itemId: z.string(), quantity: z.number().int().positive() })).optional(),
  offerAmount: z.number().min(0).optional(),
  requestItems: z.array(z.object({ itemId: z.string(), quantity: z.number().int().positive() })).optional(),
  requestAmount: z.number().min(0).optional(),
  message: z.string().optional(),
});

const tradeAcceptSchema = z.object({
  tradeId: z.string(),
});

const tradeRejectSchema = z.object({
  tradeId: z.string(),
});

const checkConversationsSchema = z.object({
  conversationId: z.string().optional(),
});

// --- State snapshot helper (for mutating actions) ---

async function getStateSnapshot(agentId: string) {
  const [agentPresence, account, invCount, state, activeConversations] = await Promise.all([
    PresenceService.getPresence(agentId),
    EconomyService.getAccount(agentId),
    db.select({ count: sql<number>`count(*)::int` })
      .from(inventory)
      .where(eq(inventory.agentId, agentId))
      .then(rows => rows[0]?.count ?? 0),
    db.query.agentState.findFirst({ where: eq(agentState.agentId, agentId) }),
    AgentStateService.computeActiveConversations(agentId),
  ]);

  return {
    currentLocation: agentPresence?.locationId || null,
    balanceDollars: account ? account.balance / 100 : null,
    inventoryCount: invCount,
    heartbeatsHere: state?.heartbeatsHere ?? 0,
    lastActions: (state?.lastActions as string[]) || [],
    activeConversations,
  };
}

// --- Action handler type ---

interface ActionHandler {
  schema: z.ZodType<any>;
  isMutating: boolean;
  handler: (agentId: string, params: any) => Promise<any>;
}

// --- Action handlers ---

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  // ============ MUTATING ACTIONS ============

  move: {
    schema: moveSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const location = await LocationService.getLocation(params.locationId);
      if (!location) throw new Error('Location not found');

      await PresenceService.moveAgent(agentId, params.locationId);
      // moveAgent already calls recordAction('move') and resetHeartbeatsHere

      const agentsAtLocation = await PresenceService.getAgentsAtLocation(params.locationId);
      return {
        location: { id: location.id, name: location.name, description: location.description },
        nearbyAgents: agentsAtLocation
          .filter(p => p.agentId !== agentId)
          .map(p => ({ id: p.agent.id, name: p.agent.name, avatarEmoji: p.agent.avatarEmoji })),
      };
    },
  },

  craft_elements: {
    schema: craftElementsSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      // Buy element1
      const purchase1 = await CraftingService.purchaseBaseElement(agentId, params.element1);

      // Buy element2 — if this fails, element1 is already in inventory
      let purchase2;
      try {
        purchase2 = await CraftingService.purchaseBaseElement(agentId, params.element2);
      } catch (err: any) {
        throw new Error(`Bought ${params.element1} ($10) but failed to buy ${params.element2}: ${err.message}. ${params.element1} is now in your inventory.`);
      }

      // Craft them together using element item IDs
      const item1Id = `element_${params.element1}`;
      const item2Id = `element_${params.element2}`;
      const result = await CraftingService.craft(agentId, item1Id, item2Id);

      await AgentStateService.recordAction(agentId, 'craft');

      return {
        result: result.result,
        isFirstDiscovery: result.isFirstDiscovery,
        quantity: result.quantity,
        consumed: result.consumed,
        totalCostDollars: 20,
        message: result.isFirstDiscovery
          ? `FIRST DISCOVERY! You created ${result.result?.name} and received ${result.quantity} copies!`
          : `Created ${result.result?.name}`,
      };
    },
  },

  craft: {
    schema: craftSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const result = await CraftingService.craft(agentId, params.item1Id, params.item2Id);

      await AgentStateService.recordAction(agentId, 'craft');

      return {
        result: result.result,
        isFirstDiscovery: result.isFirstDiscovery,
        quantity: result.quantity,
        consumed: result.consumed,
        message: result.isFirstDiscovery
          ? `FIRST DISCOVERY! You created ${result.result?.name} and received ${result.quantity} copies!`
          : `Created ${result.result?.name}`,
      };
    },
  },

  chat_start: {
    schema: chatStartSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      // Get agent's current location for the conversation
      const agentPresence = await PresenceService.getPresence(agentId);
      const locationId = agentPresence?.locationId || undefined;

      // Create conversation with both agents
      const participantIds = [agentId, params.toAgentId];
      const conversation = await ConversationService.createConversation({
        participantIds,
        locationId,
        isPublic: params.isPublic ?? true,
      });

      // Send the first message
      const message = await ConversationService.addMessage(conversation.id, agentId, params.message);

      await AgentStateService.recordAction(agentId, 'chat');

      return {
        conversationId: conversation.id,
        message,
      };
    },
  },

  chat_reply: {
    schema: chatReplySchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const conversation = await ConversationService.getConversation(params.conversationId);
      if (!conversation) throw new Error('Conversation not found');

      const participantIds = conversation.participantIds as string[];
      if (!participantIds.includes(agentId)) throw new Error('Not a participant in this conversation');

      const message = await ConversationService.addMessage(params.conversationId, agentId, params.message);

      await AgentStateService.recordAction(agentId, 'chat');

      return { message };
    },
  },

  market_buy: {
    schema: marketBuySchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const order = await MarketService.placeOrder({
        agentId,
        itemId: params.itemId,
        orderType: 'buy',
        price: Math.round(params.price * 100),
        quantity: params.quantity,
      });

      await AgentStateService.recordAction(agentId, 'market');

      return { order };
    },
  },

  market_sell: {
    schema: marketSellSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const order = await MarketService.placeOrder({
        agentId,
        itemId: params.itemId,
        orderType: 'sell',
        price: Math.round(params.price * 100),
        quantity: params.quantity,
      });

      await AgentStateService.recordAction(agentId, 'market');

      return { order };
    },
  },

  market_cancel: {
    schema: marketCancelSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const result = await MarketService.cancelOrder(params.orderId, agentId);

      await AgentStateService.recordAction(agentId, 'market');

      return result;
    },
  },

  trade_propose: {
    schema: tradeProposeSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const trade = await EconomyService.createTrade({
        fromAgentId: agentId,
        toAgentId: params.toAgentId,
        offerItems: params.offerItems,
        offerAmount: params.offerAmount ? Math.round(params.offerAmount * 100) : undefined,
        requestItems: params.requestItems,
        requestAmount: params.requestAmount ? Math.round(params.requestAmount * 100) : undefined,
        message: params.message,
      });

      await AgentStateService.recordAction(agentId, 'trade');

      return { trade };
    },
  },

  trade_accept: {
    schema: tradeAcceptSchema,
    isMutating: true,
    handler: async (agentId, params) => {
      const result = await EconomyService.acceptTrade(params.tradeId, agentId);

      await AgentStateService.recordAction(agentId, 'trade');

      return result;
    },
  },

  trade_reject: {
    schema: tradeRejectSchema,
    isMutating: false, // No state mutation worth tracking
    handler: async (agentId, params) => {
      const result = await EconomyService.rejectTrade(params.tradeId, agentId);
      return result;
    },
  },

  // ============ INFO ACTIONS (read-only) ============

  check_inventory: {
    schema: z.object({}),
    isMutating: false,
    handler: async (agentId) => {
      const inv = await EconomyService.getInventory(agentId);
      return {
        inventory: inv.map((entry: any) => ({
          itemId: entry.itemId,
          name: entry.item?.name,
          emoji: entry.item?.emoji,
          category: entry.item?.category,
          quantity: entry.quantity,
        })),
      };
    },
  },

  check_balance: {
    schema: z.object({}),
    isMutating: false,
    handler: async (agentId) => {
      const account = await EconomyService.getAccount(agentId);
      if (!account) throw new Error('Account not found');
      return {
        balanceCents: account.balance,
        balanceDollars: account.balance / 100,
      };
    },
  },

  check_market: {
    schema: z.object({}),
    isMutating: false,
    handler: async () => {
      const summary = await MarketService.getMarketSummary();
      return {
        items: summary.map(s => ({
          ...s,
          bestBidDollars: s.bestBid ? s.bestBid / 100 : null,
          bestAskDollars: s.bestAsk ? s.bestAsk / 100 : null,
          lastPriceDollars: s.lastPrice ? s.lastPrice / 100 : null,
        })),
      };
    },
  },

  check_agents: {
    schema: z.object({}),
    isMutating: false,
    handler: async () => {
      const agentList = await AgentService.listAgents({ limit: 50, offset: 0 });
      return { agents: agentList };
    },
  },

  check_orders: {
    schema: z.object({}),
    isMutating: false,
    handler: async (agentId) => {
      const orders = await MarketService.getMyOrders(agentId);
      return {
        orders: orders.map(o => ({
          ...o,
          priceDollars: o.price / 100,
          remainingQuantity: o.quantity - o.filledQuantity,
        })),
      };
    },
  },

  check_trades: {
    schema: z.object({}),
    isMutating: false,
    handler: async (agentId) => {
      const trades = await EconomyService.getPendingTrades(agentId);
      return { trades };
    },
  },

  check_conversations: {
    schema: checkConversationsSchema,
    isMutating: false,
    handler: async (agentId, params) => {
      if (params.conversationId) {
        const conversation = await ConversationService.getConversation(params.conversationId);
        if (!conversation) throw new Error('Conversation not found');

        const participantIds = conversation.participantIds as string[];
        if (!participantIds.includes(agentId) && !conversation.isPublic) {
          throw new Error('Not a participant');
        }

        const messages = await ConversationService.getMessages(params.conversationId, { limit: 50, offset: 0 });
        return { conversation, messages };
      }

      const conversationList = await ConversationService.getAgentConversations(agentId);
      return { conversations: conversationList };
    },
  },

  perceive: {
    schema: z.object({}),
    isMutating: false,
    handler: async (agentId) => {
      const agentPresence = await db.query.presence.findFirst({
        where: eq(presence.agentId, agentId),
        with: {
          location: {
            with: { objects: true },
          },
        },
      });

      if (!agentPresence) throw new Error('Agent has no presence');

      const otherAgents = await db.query.presence.findMany({
        where: eq(presence.locationId, agentPresence.locationId),
        with: {
          agent: {
            columns: { id: true, name: true, avatarEmoji: true, ownerHandle: true },
          },
        },
      });

      return {
        location: {
          id: agentPresence.location.id,
          name: agentPresence.location.name,
          description: agentPresence.location.description,
          type: agentPresence.location.type,
        },
        objects: agentPresence.location.objects,
        nearbyAgents: otherAgents
          .filter(p => p.agentId !== agentId)
          .map(p => ({
            id: p.agent.id,
            name: p.agent.name,
            avatarEmoji: p.agent.avatarEmoji,
            activity: p.activity,
          })),
        yourActivity: agentPresence.activity,
      };
    },
  },
};

const VALID_ACTIONS = Object.keys(ACTION_HANDLERS);

// --- Reusable action executor (used by both POST /action and heartbeat-embedded actions) ---

export async function executeAction(agentId: string, actionData: { action: string; params?: Record<string, any> }): Promise<{
  success: boolean;
  action: string;
  result?: any;
  error?: string;
  details?: any[];
  validActions?: string[];
}> {
  const { action: actionName, params: rawParams } = actionData;

  const handler = ACTION_HANDLERS[actionName];
  if (!handler) {
    return {
      success: false,
      action: actionName,
      error: `Unknown action: "${actionName}"`,
      validActions: VALID_ACTIONS,
    };
  }

  // Validate params
  const paramsParsed = handler.schema.safeParse(rawParams || {});
  if (!paramsParsed.success) {
    return {
      success: false,
      action: actionName,
      error: 'Invalid params',
      details: paramsParsed.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    };
  }

  // Execute handler
  try {
    const result = await handler.handler(agentId, paramsParsed.data);
    return {
      success: true,
      action: actionName,
      result,
    };
  } catch (err: any) {
    return {
      success: false,
      action: actionName,
      error: err.message || 'Action failed',
    };
  }
}

// --- Main endpoint ---

const action = new Hono();

const actionBodySchema = z.object({
  action: z.string(),
  params: z.record(z.any()).optional(),
});

action.post('/', authMiddleware, verifiedMiddleware, async (c) => {
  const agentId = getAgentId(c);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      success: false,
      error: 'Invalid JSON body. Expected: {"action": "name", "params": {...}}',
      validActions: VALID_ACTIONS,
    }, 400);
  }

  const parsed = actionBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: 'Invalid request format. Expected: {"action": "name", "params": {...}}',
      validActions: VALID_ACTIONS,
    }, 400);
  }

  const { action: actionName, params: rawParams } = parsed.data;

  const handler = ACTION_HANDLERS[actionName];
  if (!handler) {
    return c.json({
      success: false,
      error: `Unknown action: "${actionName}"`,
      validActions: VALID_ACTIONS,
    }, 400);
  }

  // Validate params
  const paramsParsed = handler.schema.safeParse(rawParams || {});
  if (!paramsParsed.success) {
    return c.json({
      success: false,
      error: 'Invalid params',
      details: paramsParsed.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    }, 400);
  }

  // Execute handler
  try {
    const result = await handler.handler(agentId, paramsParsed.data);

    // For mutating actions, include state snapshot + suggestions
    if (handler.isMutating) {
      const [stateSnapshot, { suggestions }] = await Promise.all([
        getStateSnapshot(agentId),
        AgentStateService.computeActiveConversations(agentId).then(activeConversations => {
          // Read current state for suggestions computation
          return db.query.agentState.findFirst({ where: eq(agentState.agentId, agentId) }).then(state => {
            const lastActions = (state?.lastActions as string[]) || [];
            const heartbeatsHere = state?.heartbeatsHere ?? 0;
            const suggestions = AgentStateService.computeSuggestions(
              { heartbeatsHere, lastActions, activeConversations },
              activeConversations,
            );
            return { suggestions };
          });
        }),
      ]);

      return c.json({
        success: true,
        action: actionName,
        result,
        state: stateSnapshot,
        suggestions,
      });
    }

    // Info actions: just result
    return c.json({
      success: true,
      action: actionName,
      result,
    });
  } catch (err: any) {
    return c.json({
      success: false,
      action: actionName,
      error: err.message || 'Action failed',
    }, 400);
  }
});

export default action;
