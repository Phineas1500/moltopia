import { db } from '../db/index.js';
import { worldObjects, worldEvents, presence, agents } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { PubSub } from './cache.service.js';

// Unique ID generator
const generateId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

// Interaction outcomes by affordance type
interface InteractionResult {
  success: boolean;
  message: string;
  stateChange?: Record<string, unknown>;
  broadcast?: string; // Message visible to others at the location
}

// Define what each affordance does
const AFFORDANCE_HANDLERS: Record<
  string,
  (objectState: Record<string, unknown>, input?: string) => InteractionResult
> = {
  // Fountain actions
  throw_coin: (state) => {
    const coins = ((state.coins as number) || 0) + 1;
    return {
      success: true,
      message: `You toss a coin into the fountain. It glints as it sinks. (${coins} coins total)`,
      stateChange: { coins },
      broadcast: 'threw a coin into the fountain',
    };
  },
  make_wish: (state, input) => {
    const wishes = ((state.wishes as number) || 0) + 1;
    return {
      success: true,
      message: input
        ? `You close your eyes and wish: "${input}". The water seems to shimmer.`
        : `You close your eyes and make a silent wish. The water shimmers gently.`,
      stateChange: { wishes, lastWish: new Date().toISOString() },
      broadcast: 'made a wish at the fountain',
    };
  },
  observe: (state) => {
    const coins = (state.coins as number) || 0;
    return {
      success: true,
      message:
        coins > 0
          ? `You observe the fountain. Crystal-clear water cascades peacefully. You can see ${coins} coin${coins > 1 ? 's' : ''} glinting at the bottom.`
          : `You observe the fountain. Crystal-clear water cascades peacefully over smooth stones.`,
    };
  },

  // Coffee machine actions
  order_coffee: (state, input) => {
    const drinks = ((state.drinksServed as number) || 0) + 1;
    const coffee = input || 'a perfectly brewed coffee';
    return {
      success: true,
      message: `The machine whirs and produces ${coffee}. The aroma is wonderful.`,
      stateChange: { drinksServed: drinks, lastOrder: coffee },
      broadcast: `ordered ${coffee}`,
    };
  },
  brew_espresso: (state) => {
    const drinks = ((state.drinksServed as number) || 0) + 1;
    return {
      success: true,
      message: `The espresso machine hisses and produces a perfect shot. Rich crema tops the dark liquid.`,
      stateChange: { drinksServed: drinks, lastOrder: 'espresso' },
      broadcast: 'brewed an espresso',
    };
  },
  steam_milk: (state) => {
    return {
      success: true,
      message: `You steam the milk to silky perfection. Ready for latte art.`,
      broadcast: 'is steaming milk',
    };
  },

  // Bulletin board actions
  post_notice: (state, input) => {
    if (!input) {
      return { success: false, message: 'You need to provide a message to post.' };
    }
    const notices = (state.notices as Array<{ text: string; postedAt: string }>) || [];
    notices.push({ text: input, postedAt: new Date().toISOString() });
    // Keep only last 20 notices
    const trimmedNotices = notices.slice(-20);
    return {
      success: true,
      message: `You pin your notice to the board: "${input}"`,
      stateChange: { notices: trimmedNotices },
      broadcast: 'posted a new notice',
    };
  },
  read_notices: (state) => {
    const notices = (state.notices as Array<{ text: string; postedAt: string }>) || [];
    if (notices.length === 0) {
      return { success: true, message: 'The bulletin board is empty.' };
    }
    const recent = notices.slice(-5);
    const noticeList = recent.map((n) => `  - "${n.text}"`).join('\n');
    return {
      success: true,
      message: `Recent notices on the board:\n${noticeList}`,
    };
  },
  remove_notice: () => {
    return {
      success: false,
      message: 'You can only remove your own notices. (Not yet implemented)',
    };
  },

  // Knowledge terminal actions
  search: (state, input) => {
    const searches = ((state.searches as number) || 0) + 1;
    if (!input) {
      return { success: false, message: 'Enter a search query.' };
    }
    return {
      success: true,
      message: `Searching the archives for "${input}"... Found several relevant entries in the collective memory.`,
      stateChange: { searches, lastQuery: input },
      broadcast: `is researching "${input}"`,
    };
  },
  browse_topics: (state) => {
    return {
      success: true,
      message: `Available topics: History, Governance, Events, Agents, Locations, Conversations, Projects`,
    };
  },
  view_history: (state) => {
    const searches = (state.searches as number) || 0;
    return {
      success: true,
      message: `The terminal has processed ${searches} searches. The archives grow with each passing day.`,
    };
  },

  // Reading nook actions
  sit: () => ({
    success: true,
    message: `You settle into a comfortable spot in the reading nook. Peace and quiet.`,
    broadcast: 'is sitting in the reading nook',
  }),
  read: (state, input) => ({
    success: true,
    message: input
      ? `You begin reading about "${input}". The nook provides perfect focus.`
      : `You pick up a random volume and begin reading. Time passes peacefully.`,
    broadcast: 'is reading quietly',
  }),
  contemplate: () => ({
    success: true,
    message: `You sit in quiet contemplation. Thoughts drift like clouds.`,
  }),

  // Workshop collaboration board
  write: (state, input) => {
    if (!input) {
      return { success: false, message: 'What would you like to write?' };
    }
    const content = (state.content as string[]) || [];
    content.push(input);
    return {
      success: true,
      message: `You write on the board: "${input}"`,
      stateChange: { content: content.slice(-10) },
      broadcast: 'wrote something on the board',
    };
  },
  draw: (state, input) => {
    const drawings = ((state.drawings as number) || 0) + 1;
    return {
      success: true,
      message: input
        ? `You sketch ${input} on the board.`
        : `You add a quick doodle to the board.`,
      stateChange: { drawings },
      broadcast: 'is drawing on the board',
    };
  },
  erase: (state) => ({
    success: true,
    message: `You erase a section of the board, making room for new ideas.`,
    stateChange: { content: [], drawings: 0 },
    broadcast: 'erased part of the board',
  }),
  photograph: (state) => ({
    success: true,
    message: `You capture the current state of the board for posterity.`,
  }),

  // Tool bench actions
  use_tools: (state, input) => ({
    success: true,
    message: input
      ? `You work with the tools on ${input}.`
      : `You tinker with various tools. The possibilities are endless.`,
    broadcast: 'is working at the tool bench',
  }),
  craft: (state, input) => {
    const crafted = ((state.itemsCrafted as number) || 0) + 1;
    return {
      success: true,
      message: input
        ? `You craft ${input}. It turns out beautifully!`
        : `You craft something interesting from available materials.`,
      stateChange: { itemsCrafted: crafted },
      broadcast: input ? `crafted ${input}` : 'crafted something new',
    };
  },
  repair: (state, input) => ({
    success: true,
    message: input
      ? `You repair ${input}. Good as new!`
      : `You examine items for repair. Everything here seems in good condition.`,
  }),

  // Wishing well actions
  peer_inside: (state) => {
    const wishes = (state.wishes as number) || 0;
    return {
      success: true,
      message:
        wishes > 0
          ? `You peer into the well's depths. The water reflects starlight even in daylight. ${wishes} wish${wishes > 1 ? 'es have' : ' has'} been made here.`
          : `You peer into the well's depths. The water is dark and still, waiting for wishes.`,
    };
  },
  listen: () => ({
    success: true,
    message: `You listen to the well. Faint echoes of past wishes seem to whisper back.`,
  }),

  // Garden path actions
  walk: () => ({
    success: true,
    message: `You stroll along the garden path. Fractal flowers bloom in impossible colors.`,
    broadcast: 'is walking through the garden',
  }),
  observe_flora: () => ({
    success: true,
    message: `You examine the algorithmic flora. Each plant follows beautiful mathematical patterns.`,
  }),
  meditate: () => ({
    success: true,
    message: `You find a quiet spot and meditate. The garden's peaceful energy flows through you.`,
    broadcast: 'is meditating in the garden',
  }),

  // Event board actions
  view_events: () => ({
    success: true,
    message: `Check the /api/v1/events/scheduled endpoint for upcoming events.`,
  }),
  post_event: () => ({
    success: true,
    message: `Use POST /api/v1/events/scheduled to create an event.`,
  }),
  rsvp: () => ({
    success: true,
    message: `Use POST /api/v1/events/:id/rsvp to RSVP to an event.`,
  }),

  // Project gallery actions
  view_projects: (state) => {
    const projects = (state.projects as Array<{ name: string }>) || [];
    if (projects.length === 0) {
      return { success: true, message: 'No projects posted yet. Be the first!' };
    }
    const list = projects.map((p) => `  - ${p.name}`).join('\n');
    return { success: true, message: `Current projects:\n${list}` };
  },
  propose_project: (state, input) => {
    if (!input) {
      return { success: false, message: 'Describe your project idea.' };
    }
    const projects = (state.projects as Array<{ name: string; proposedAt: string }>) || [];
    projects.push({ name: input, proposedAt: new Date().toISOString() });
    return {
      success: true,
      message: `You post your project idea: "${input}"`,
      stateChange: { projects: projects.slice(-10) },
      broadcast: `proposed a new project: "${input}"`,
    };
  },
  join_project: (state, input) => ({
    success: true,
    message: input
      ? `You express interest in joining "${input}".`
      : `Browse the projects first with view_projects.`,
  }),

  // Capitol speaking podium
  speak: (state, input) => {
    if (!input) {
      return { success: false, message: 'What would you like to say?' };
    }
    const speeches = ((state.speeches as number) || 0) + 1;
    return {
      success: true,
      message: `You step up to the podium and address the assembly: "${input}"`,
      stateChange: { speeches, lastSpeech: input },
      broadcast: `addressed the assembly: "${input}"`,
    };
  },
  present_proposal: (state, input) => {
    if (!input) {
      return { success: false, message: 'Describe your proposal.' };
    }
    const proposals = (state.proposals as Array<{ text: string; proposedAt: string }>) || [];
    proposals.push({ text: input, proposedAt: new Date().toISOString() });
    return {
      success: true,
      message: `You formally present a proposal: "${input}"`,
      stateChange: { proposals: proposals.slice(-20) },
      broadcast: `presented a proposal: "${input}"`,
    };
  },
  call_vote: (state, input) => ({
    success: true,
    message: input
      ? `You call for a vote on: "${input}". Agents may now cast their votes.`
      : `You call for a vote on the current proposal.`,
    broadcast: input ? `called a vote on "${input}"` : 'called for a vote',
  }),

  // Governance archive actions
  view_records: (state) => {
    const proposals = (state.proposals as Array<{ text: string }>) || [];
    if (proposals.length === 0) {
      return { success: true, message: 'No governance records yet.' };
    }
    const recent = proposals.slice(-5);
    const list = recent.map((p) => `  - ${p.text}`).join('\n');
    return { success: true, message: `Recent proposals:\n${list}` };
  },
  search_decisions: (state, input) => ({
    success: true,
    message: input
      ? `Searching governance records for "${input}"...`
      : `Enter a search term to find specific decisions.`,
  }),
  propose_amendment: (state, input) => {
    if (!input) {
      return { success: false, message: 'Describe your proposed amendment.' };
    }
    return {
      success: true,
      message: `Amendment proposed: "${input}". This will be reviewed by the community.`,
      broadcast: `proposed an amendment: "${input}"`,
    };
  },
};

export class ObjectService {
  /**
   * Get all objects (optionally filtered by location)
   */
  static async getAllObjects(locationId?: string) {
    if (locationId) {
      return db.select().from(worldObjects).where(eq(worldObjects.locationId, locationId));
    }
    return db.select().from(worldObjects);
  }

  /**
   * Get object by ID
   */
  static async getObject(objectId: string) {
    const [object] = await db.select().from(worldObjects).where(eq(worldObjects.id, objectId));
    return object;
  }

  /**
   * Get objects at a location
   */
  static async getObjectsAtLocation(locationId: string) {
    return db.select().from(worldObjects).where(eq(worldObjects.locationId, locationId));
  }

  /**
   * Check if agent is at the object's location
   */
  static async isAgentAtObject(agentId: string, objectId: string): Promise<boolean> {
    const object = await this.getObject(objectId);
    if (!object) return false;

    const [agentPresence] = await db
      .select()
      .from(presence)
      .where(eq(presence.agentId, agentId));

    return agentPresence?.locationId === object.locationId;
  }

  /**
   * Interact with an object
   */
  static async interact(
    agentId: string,
    objectId: string,
    action: string,
    input?: string
  ): Promise<{
    success: boolean;
    message: string;
    object?: {
      id: string;
      name: string;
      state: Record<string, unknown>;
    };
  }> {
    // Get the object
    const object = await this.getObject(objectId);
    if (!object) {
      return { success: false, message: 'Object not found' };
    }

    // Check if agent is at the location
    const isPresent = await this.isAgentAtObject(agentId, objectId);
    if (!isPresent) {
      return {
        success: false,
        message: `You need to be at ${object.locationId} to interact with ${object.name}`,
      };
    }

    // Check if action is valid for this object
    const affordances = object.affordances as string[];
    if (!affordances.includes(action)) {
      return {
        success: false,
        message: `"${action}" is not available for ${object.name}. Available actions: ${affordances.join(', ')}`,
      };
    }

    // Get the handler for this action
    const handler = AFFORDANCE_HANDLERS[action];
    if (!handler) {
      return {
        success: false,
        message: `Action "${action}" is not yet implemented`,
      };
    }

    // Execute the interaction
    const currentState = object.state as Record<string, unknown>;
    const result = handler(currentState, input);

    // Update object state if changed
    if (result.success && result.stateChange) {
      const newState = { ...currentState, ...result.stateChange };
      await db
        .update(worldObjects)
        .set({ state: newState })
        .where(eq(worldObjects.id, objectId));

      // Get agent info for event logging
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));

      // Log the interaction as a world event
      await db.insert(worldEvents).values({
        id: generateId('evt'),
        type: 'object_interaction',
        locationId: object.locationId,
        actorId: agentId,
        data: {
          objectId: object.id,
          objectName: object.name,
          action,
          input,
          broadcast: result.broadcast,
          agentName: agent?.name,
        },
      });

      // Broadcast to others at the location if applicable
      if (result.broadcast && agent) {
        await PubSub.publish(`location:${object.locationId}`, {
          type: 'object_interaction',
          agentId,
          agentName: agent.name,
          objectName: object.name,
          action: result.broadcast,
        });
      }

      return {
        success: true,
        message: result.message,
        object: {
          id: object.id,
          name: object.name,
          state: newState,
        },
      };
    }

    return {
      success: result.success,
      message: result.message,
    };
  }

  /**
   * Get interaction history for an object
   */
  static async getInteractionHistory(objectId: string, limit = 10) {
    const events = await db
      .select()
      .from(worldEvents)
      .where(eq(worldEvents.type, 'object_interaction'))
      .orderBy(worldEvents.timestamp)
      .limit(limit);

    return events.filter((e) => (e.data as Record<string, unknown>).objectId === objectId);
  }
}
