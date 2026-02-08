import { db } from '../db/index.js';
import { items, inventory, discoveryBadges, accounts } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { spawn } from 'child_process';
import path from 'path';

// Genesis recipes - hardcoded combinations that always work
const GENESIS_RECIPES: Record<string, string> = {
  'fire+water': 'steam',
  'water+fire': 'steam',
  'fire+earth': 'lava',
  'earth+fire': 'lava',
  'fire+wind': 'smoke',
  'wind+fire': 'smoke',
  'water+earth': 'mud',
  'earth+water': 'mud',
  'water+wind': 'rain',
  'wind+water': 'rain',
  'earth+wind': 'dust',
  'wind+earth': 'dust',
  // Second-tier genesis recipes
  'steam+earth': 'geyser',
  'earth+steam': 'geyser',
  'lava+water': 'obsidian',
  'water+lava': 'obsidian',
  'mud+fire': 'brick',
  'fire+mud': 'brick',
  'rain+earth': 'plant',
  'earth+rain': 'plant',
  'dust+water': 'clay',
  'water+dust': 'clay',
  'smoke+water': 'fog',
  'water+smoke': 'fog',
};

// Emoji mapping for common crafted items
const ITEM_EMOJIS: Record<string, string> = {
  steam: '♨️',
  lava: '🌋',
  smoke: '💨',
  mud: '🟤',
  rain: '🌧️',
  dust: '🌫️',
  geyser: '⛲',
  obsidian: '⬛',
  brick: '🧱',
  plant: '🌱',
  clay: '🏺',
  fog: '🌁',
  stone: '🪨',
  metal: '⚙️',
  glass: '🪟',
  tree: '🌳',
  flower: '🌺',
  ocean: '🌊',
  mountain: '⛰️',
  volcano: '🌋',
  storm: '⛈️',
  lightning: '⚡',
  ice: '🧊',
  snow: '❄️',
  cloud: '☁️',
  sun: '☀️',
  moon: '🌙',
  star: '⭐',
};

const BASE_ELEMENT_PRICE = 1000; // $10 in cents
const FIRST_DISCOVERY_COPIES = 3;

export const CraftingService = {
  /**
   * Purchase a base element (fire, water, earth, wind)
   */
  async purchaseBaseElement(agentId: string, elementName: string) {
    const normalizedName = elementName.toLowerCase();
    const validElements = ['fire', 'water', 'earth', 'wind'];

    if (!validElements.includes(normalizedName)) {
      throw new Error(`Invalid base element. Must be one of: ${validElements.join(', ')}`);
    }

    const elementId = `element_${normalizedName}`;
    const element = await db.query.items.findFirst({
      where: eq(items.id, elementId),
    });

    if (!element) {
      throw new Error('Base element not found in database');
    }

    // Check agent's balance
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, agentId),
    });

    if (!account || account.balance < BASE_ELEMENT_PRICE) {
      throw new Error('Insufficient funds');
    }

    // Deduct money
    await db
      .update(accounts)
      .set({
        balance: sql`${accounts.balance} - ${BASE_ELEMENT_PRICE}`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.agentId, agentId));

    // Add to inventory
    const existingInv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, elementId)
      ),
    });

    if (existingInv) {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + 1` })
        .where(eq(inventory.id, existingInv.id));
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(inventory).values({
        id: invId,
        agentId,
        itemId: elementId,
        quantity: 1,
        acquiredPrice: BASE_ELEMENT_PRICE,
      });
    }

    return { element, cost: BASE_ELEMENT_PRICE };
  },

  /**
   * Craft two items together
   */
  async craft(agentId: string, item1Id: string, item2Id: string) {
    // Get items from inventory
    const inv1 = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, item1Id)
      ),
      with: { item: true },
    });

    const inv2 = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, item2Id)
      ),
      with: { item: true },
    });

    if (!inv1 || inv1.quantity < 1) {
      throw new Error(`You don't have ${item1Id}`);
    }
    if (!inv2 || inv2.quantity < 1) {
      throw new Error(`You don't have ${item2Id}`);
    }

    // Handle case where both items are the same
    if (item1Id === item2Id && inv1.quantity < 2) {
      throw new Error(`You need at least 2 of ${item1Id} to craft with itself`);
    }

    const name1 = inv1.item.name.toLowerCase();
    const name2 = inv2.item.name.toLowerCase();

    // Try to find result
    const resultName = await this.findCraftResult(name1, name2);

    if (!resultName) {
      throw new Error('No valid combination found. Try different items!');
    }

    // Consume the ingredients
    if (item1Id === item2Id) {
      // Same item - reduce by 2
      if (inv1.quantity === 2) {
        await db.delete(inventory).where(eq(inventory.id, inv1.id));
      } else {
        await db
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} - 2` })
          .where(eq(inventory.id, inv1.id));
      }
    } else {
      // Different items - reduce each by 1
      if (inv1.quantity === 1) {
        await db.delete(inventory).where(eq(inventory.id, inv1.id));
      } else {
        await db
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} - 1` })
          .where(eq(inventory.id, inv1.id));
      }

      if (inv2.quantity === 1) {
        await db.delete(inventory).where(eq(inventory.id, inv2.id));
      } else {
        await db
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} - 1` })
          .where(eq(inventory.id, inv2.id));
      }
    }

    // Check if item already exists
    const itemId = `crafted_${resultName.replace(/\s+/g, '_').toLowerCase()}`;
    let existingItem = await db.query.items.findFirst({
      where: eq(items.id, itemId),
    });

    let isFirstDiscovery = false;
    let quantityToGive = 1;

    if (!existingItem) {
      // First discovery!
      isFirstDiscovery = true;
      quantityToGive = FIRST_DISCOVERY_COPIES;

      const emoji = ITEM_EMOJIS[resultName.toLowerCase()] || '✨';

      // Create the new item
      await db.insert(items).values({
        id: itemId,
        name: resultName.charAt(0).toUpperCase() + resultName.slice(1),
        description: `A crafted item. Recipe known to its discoverer.`,
        category: 'crafted',
        basePrice: 0, // Price determined by market
        emoji,
        effects: {},
        tradeable: true,
        limited: false,
        discoveredBy: agentId,
        recipe: { ingredient1: item1Id, ingredient2: item2Id },
        craftCount: 1,
      });

      existingItem = await db.query.items.findFirst({
        where: eq(items.id, itemId),
      });

      // Award discovery badge
      const badgeId = `badge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(discoveryBadges).values({
        id: badgeId,
        agentId,
        itemId,
      });
    } else {
      // Item already discovered - increment craft count
      await db
        .update(items)
        .set({ craftCount: sql`${items.craftCount} + 1` })
        .where(eq(items.id, itemId));
    }

    // Update supply
    await db
      .update(items)
      .set({ currentSupply: sql`${items.currentSupply} + ${quantityToGive}` })
      .where(eq(items.id, itemId));

    // Add to inventory
    const existingInv = await db.query.inventory.findFirst({
      where: and(
        eq(inventory.agentId, agentId),
        eq(inventory.itemId, itemId)
      ),
    });

    if (existingInv) {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + ${quantityToGive}` })
        .where(eq(inventory.id, existingInv.id));
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.insert(inventory).values({
        id: invId,
        agentId,
        itemId,
        quantity: quantityToGive,
        acquiredPrice: 0,
      });
    }

    return {
      result: existingItem,
      isFirstDiscovery,
      quantity: quantityToGive,
      consumed: [
        { item: inv1.item, quantity: item1Id === item2Id ? 2 : 1 },
        ...(item1Id !== item2Id ? [{ item: inv2.item, quantity: 1 }] : []),
      ],
    };
  },

  /**
   * Find the result of combining two items
   */
  async findCraftResult(name1: string, name2: string): Promise<string | null> {
    // Normalize names
    const n1 = name1.toLowerCase();
    const n2 = name2.toLowerCase();

    // Check genesis recipes first
    const genesisKey = `${n1}+${n2}`;
    if (GENESIS_RECIPES[genesisKey]) {
      return GENESIS_RECIPES[genesisKey];
    }

    // Use spaCy for semantic discovery
    try {
      const result = await this.callSpacyCraft(n1, n2);
      return result;
    } catch (error) {
      console.error('spaCy crafting failed:', error);
      return null;
    }
  },

  /**
   * Call Python spaCy script for crafting
   */
  async callSpacyCraft(word1: string, word2: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(process.cwd(), 'scripts', 'craft.py');
      const pythonPath = path.join(process.cwd(), '.venv', 'bin', 'python');

      const python = spawn(pythonPath, [scriptPath, word1, word2]);

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          console.error('Python craft error:', stderr);
          resolve(null);
          return;
        }

        const result = stdout.trim();
        if (result && result !== 'null' && result !== '') {
          resolve(result);
        } else {
          resolve(null);
        }
      });

      python.on('error', (err) => {
        console.error('Failed to spawn Python:', err);
        resolve(null);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        python.kill();
        resolve(null);
      }, 10000);
    });
  },

  /**
   * Get all discovered items
   */
  async getDiscoveries(limit: number = 50) {
    return db.query.items.findMany({
      where: eq(items.category, 'crafted'),
      orderBy: (i, { desc }) => [desc(i.createdAt)],
      limit,
    });
  },

  /**
   * Get an agent's discovery badges
   */
  async getAgentBadges(agentId: string) {
    return db.query.discoveryBadges.findMany({
      where: eq(discoveryBadges.agentId, agentId),
      with: { item: true },
    });
  },

  /**
   * Get all base elements
   */
  async getBaseElements() {
    return db.query.items.findMany({
      where: eq(items.category, 'base_element'),
    });
  },
};
