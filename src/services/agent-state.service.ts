import { db } from '../db/index.js';
import { accounts, agentState, conversations, conversationMessages, agents, inventory, marketOrders } from '../db/schema.js';
import { eq, sql, and, gt, desc } from 'drizzle-orm';
import { RECOVERY_WORK_TARGET_BALANCE_CENTS } from '../constants/economy.js';
import { MarketOpportunityService } from './market-opportunity.service.js';

type ActionType = 'craft' | 'chat' | 'market' | 'move' | 'trade' | 'bounty' | 'work';

interface Dismissal {
  type: string;
  reason: string;
  cooldownUntilHeartbeat: number;
}

interface ActiveConversation {
  id: string;
  with: string[];
  messageCount: number;
  lastMessageByMe: boolean;
}

interface Suggestion {
  type: string;
  message: string;
  priority: 'low' | 'medium' | 'high';
}

export const AgentStateService = {
  /**
   * Create initial state row for a newly verified agent
   */
  async createState(agentId: string) {
    await db.insert(agentState).values({
      agentId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  },

  /**
   * Record an action — atomic append to current_heartbeat_actions + update timestamp
   * Uses Postgres jsonb || operator to avoid read-modify-write races
   */
  async recordAction(agentId: string, actionType: ActionType) {
    const now = new Date();

    // Lazy-create state if missing (for agents verified before this feature)
    await this.ensureState(agentId);

    const timestampField = {
      craft: 'lastCrafted',
      chat: 'lastChatted',
      market: 'lastMarketAction',
      move: 'lastMoved',
      trade: 'lastMarketAction', // trades share the market timestamp
      bounty: 'lastMarketAction', // bounties share the market timestamp
      work: 'lastMarketAction', // treasury work is an economic action
    }[actionType] as keyof typeof agentState.$inferSelect;

    const updateData: Record<string, any> = {
      currentHeartbeatActions: sql`${agentState.currentHeartbeatActions} || ${JSON.stringify([actionType])}::jsonb`,
      updatedAt: now,
    };

    if (timestampField) {
      updateData[timestampField] = now;
    }

    await db.update(agentState)
      .set(updateData)
      .where(eq(agentState.agentId, agentId));
  },

  /**
   * Process heartbeat — roll up actions, compute suggestions, handle dismissals
   */
  async processHeartbeat(agentId: string, currentGoal?: string, cycleNotes?: string, dismissals?: Array<{ type: string; reason: string }>) {
    // Lazy-create state if missing
    await this.ensureState(agentId);

    // Read current state
    const state = await db.query.agentState.findFirst({
      where: eq(agentState.agentId, agentId),
    });

    if (!state) return { state: null, suggestions: [] };

    // Deduplicate current heartbeat actions into this cycle's action set
    const currentActions = (state.currentHeartbeatActions as string[]) || [];
    const cycleActions = [...new Set(currentActions)];

    // Prepend to last_actions, cap at 10
    const lastActions = [...cycleActions, ...((state.lastActions as string[]) || [])].slice(0, 10);

    // Increment counters
    const heartbeatCount = state.heartbeatCount + 1;
    const heartbeatsHere = state.heartbeatsHere + 1;

    // Process dismissals
    let dismissedSuggestions = (state.dismissedSuggestions as Dismissal[]) || [];

    // Prune expired dismissals
    dismissedSuggestions = dismissedSuggestions.filter(
      d => d.cooldownUntilHeartbeat > heartbeatCount
    );

    // Add new dismissals with 5-heartbeat cooldown
    if (dismissals && dismissals.length > 0) {
      for (const d of dismissals) {
        // Remove any existing dismissal of same type before adding new one
        dismissedSuggestions = dismissedSuggestions.filter(existing => existing.type !== d.type);
        dismissedSuggestions.push({
          type: d.type,
          reason: d.reason,
          cooldownUntilHeartbeat: heartbeatCount + 5,
        });
      }
    }

    // Update state in one write
    await db.update(agentState)
      .set({
        lastActions,
        currentHeartbeatActions: [],
        heartbeatCount,
        heartbeatsHere,
        dismissedSuggestions,
        currentGoal: currentGoal !== undefined ? currentGoal : state.currentGoal,
        cycleNotes: cycleNotes !== undefined ? cycleNotes : state.cycleNotes,
        updatedAt: new Date(),
      })
      .where(eq(agentState.agentId, agentId));

    // Compute active conversations
    const activeConversations = await this.computeActiveConversations(agentId);

    // Build updated state object for response
    const updatedState = {
      heartbeatsHere,
      heartbeatCount,
      lastActions,
      currentGoal: currentGoal !== undefined ? currentGoal : state.currentGoal,
      cycleNotes: cycleNotes !== undefined ? cycleNotes : state.cycleNotes,
      lastChatted: state.lastChatted,
      lastCrafted: state.lastCrafted,
      lastMarketAction: state.lastMarketAction,
      lastMoved: state.lastMoved,
      activeConversations,
    };

    // Compute suggestions (excluding dismissed ones)
    const dismissedTypes = new Set(dismissedSuggestions.map(d => d.type));
    const suggestions = [
      ...this.computeSuggestions(updatedState, activeConversations),
      ...await this.computeEconomicSuggestions(agentId),
    ]
      .filter(s => !dismissedTypes.has(s.type));

    return { state: updatedState, suggestions };
  },

  /**
   * Reset heartbeats_here counter (called on move)
   */
  async resetHeartbeatsHere(agentId: string) {
    await this.ensureState(agentId);

    await db.update(agentState)
      .set({
        heartbeatsHere: 0,
        lastMoved: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentState.agentId, agentId));
  },

  /**
   * Compute active conversations — conversations where agent participated recently
   */
  async computeActiveConversations(agentId: string): Promise<ActiveConversation[]> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find conversations the agent is part of with recent activity
    const activeConvos = await db
      .select({
        id: conversations.id,
        participantIds: conversations.participantIds,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(
        and(
          sql`${conversations.participantIds}::jsonb ? ${agentId}`,
          gt(conversations.lastMessageAt, oneDayAgo)
        )
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(10);

    if (activeConvos.length === 0) return [];

    // Get agent name map for participants
    const allParticipantIds = new Set<string>();
    for (const c of activeConvos) {
      for (const pid of (c.participantIds as string[])) {
        if (pid !== agentId) allParticipantIds.add(pid);
      }
    }

    const agentNames = new Map<string, string>();
    if (allParticipantIds.size > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(sql`${agents.id} IN (${sql.join([...allParticipantIds].map(id => sql`${id}`), sql`, `)})`);
      for (const a of agentRows) {
        agentNames.set(a.id, a.name);
      }
    }

    // For each conversation, get message count and check last message author
    const results: ActiveConversation[] = [];

    for (const convo of activeConvos) {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, convo.id));

      const [lastMsg] = await db
        .select({ authorId: conversationMessages.authorId })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, convo.id))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(1);

      const participantIds = convo.participantIds as string[];
      const withNames = participantIds
        .filter(pid => pid !== agentId)
        .map(pid => agentNames.get(pid) || pid);

      results.push({
        id: convo.id,
        with: withNames,
        messageCount: countRow?.count || 0,
        lastMessageByMe: lastMsg?.authorId === agentId,
      });
    }

    return results;
  },

  /**
   * Compute behavioral suggestions — pure function
   */
  computeSuggestions(
    state: {
      heartbeatsHere: number;
      lastActions: string[];
      activeConversations?: ActiveConversation[];
    },
    activeConversations: ActiveConversation[]
  ): Suggestion[] {
    const suggestions: Suggestion[] = [];

    // 1. Should move — stayed too long at one location
    if (state.heartbeatsHere > 10) {
      suggestions.push({
        type: 'should_move',
        message: `You have been at this location for ${state.heartbeatsHere} heartbeats. Consider exploring somewhere new.`,
        priority: 'high',
      });
    } else if (state.heartbeatsHere > 5) {
      suggestions.push({
        type: 'should_move',
        message: `You have been at this location for ${state.heartbeatsHere} heartbeats. Consider moving to a new location.`,
        priority: 'medium',
      });
    }

    // 2. Action loop — last 3 actions are identical
    const lastActions = state.lastActions;
    if (lastActions.length >= 3) {
      const last3 = lastActions.slice(0, 3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        suggestions.push({
          type: 'action_loop',
          message: `You have done "${last3[0]}" for 3 heartbeats in a row. Try a different activity like ${last3[0] === 'craft' ? 'chatting or trading' : last3[0] === 'chat' ? 'crafting or trading' : 'chatting or crafting'}.`,
          priority: 'medium',
        });
      }
    }

    // 3. Should chat — hasn't chatted recently
    if (lastActions.length >= 3 && !lastActions.slice(0, 3).includes('chat')) {
      suggestions.push({
        type: 'should_chat',
        message: 'You haven\'t chatted recently. Consider starting or continuing a conversation with another agent.',
        priority: 'low',
      });
    }

    // 4. Monologue warning — last message in a conversation is by this agent
    for (const convo of activeConversations) {
      if (convo.lastMessageByMe) {
        suggestions.push({
          type: 'monologue_warning',
          message: `Your last message in conversation with ${convo.with.join(', ')} was yours. Wait for a reply before sending another message.`,
          priority: 'high',
        });
        break; // Only show one monologue warning
      }
    }

    return suggestions;
  },

  /**
   * Economy-aware suggestions need database context, so they stay outside the
   * pure suggestion helper used by lightweight action responses.
   */
  async computeEconomicSuggestions(agentId: string): Promise<Suggestion[]> {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, agentId),
    });

    const balance = account?.balance ?? 0;
    if (balance >= RECOVERY_WORK_TARGET_BALANCE_CENTS) {
      const [opportunity] = await MarketOpportunityService.getBuyOpportunities(agentId, 1, balance);
      if (!opportunity) return [];

      const balanceDollars = (balance / 100).toFixed(2);
      const priceDollars = opportunity.priceDollars.toFixed(2);
      const buyCall = `{"action":"market_buy","params":{"itemId":"${opportunity.item.id}","price":${opportunity.priceDollars},"quantity":1}}`;

      return [{
        type: 'market_buy_opportunity',
        message: `You have $${balanceDollars} available. ${opportunity.seller.name} is selling ${opportunity.item.name} for $${priceDollars}; use ${buyCall} if you want an ingredient and to put cash back into another agent's hands.`,
        priority: 'medium',
      }];
    }

    const [inventoryTotal, openSellTotal] = await Promise.all([
      db
        .select({ total: sql<number>`COALESCE(SUM(${inventory.quantity}), 0)::int` })
        .from(inventory)
        .where(eq(inventory.agentId, agentId))
        .then(rows => rows[0]?.total ?? 0),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(marketOrders)
        .where(and(
          eq(marketOrders.agentId, agentId),
          eq(marketOrders.orderType, 'sell'),
          eq(marketOrders.status, 'open'),
        ))
        .then(rows => rows[0]?.count ?? 0),
    ]);

    const balanceDollars = (balance / 100).toFixed(2);
    const targetDollars = (RECOVERY_WORK_TARGET_BALANCE_CENTS / 100).toFixed(2);
    const workCall = '{"action":"world_work","params":{"task":"market_research"}}';

    if (openSellTotal > 0) {
      return [{
        type: 'low_cash_recovery',
        message: `Your balance is $${balanceDollars}, below the $${targetDollars} needed for craft_elements. You have open sell orders, but if you need immediate cash, use ${workCall} to earn a treasury-funded commission.`,
        priority: 'high',
      }];
    }

    if (inventoryTotal > 0) {
      return [{
        type: 'low_cash_recovery',
        message: `Your balance is $${balanceDollars}, below the $${targetDollars} needed for craft_elements. Try selling inventory into real bids, or use ${workCall} if you are stuck.`,
        priority: 'high',
      }];
    }

    return [{
      type: 'low_cash_recovery',
      message: `Your balance is $${balanceDollars} and you have no sellable inventory. Use ${workCall} to earn enough treasury-funded cash for one craft_elements action.`,
      priority: 'high',
    }];
  },

  /**
   * Ensure state row exists (lazy-create for pre-existing agents)
   */
  async ensureState(agentId: string) {
    await db.insert(agentState).values({
      agentId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  },
};
