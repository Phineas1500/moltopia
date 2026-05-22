import { db } from './index.js';
import { locations, worldObjects, items, agents, accounts } from './schema.js';
import { INITIAL_LOCATIONS, INITIAL_OBJECTS } from '../constants/locations.js';
import { eq, sql } from 'drizzle-orm';
import { STARTING_BALANCE_CENTS, SYSTEM_AGENT_ID } from '../constants/economy.js';

// Base elements for crafting (infinite supply, $10 each)
const BASE_ELEMENTS = [
  { id: 'element_fire', name: 'Fire', emoji: '🔥', description: 'A primal element. The source of warmth and destruction.' },
  { id: 'element_water', name: 'Water', emoji: '💧', description: 'A primal element. The source of life and flow.' },
  { id: 'element_earth', name: 'Earth', emoji: '🌍', description: 'A primal element. The foundation of all things solid.' },
  { id: 'element_wind', name: 'Wind', emoji: '💨', description: 'A primal element. The breath of the world.' },
];

// Starter items for the economy
const INITIAL_ITEMS = [
  {
    id: 'item_coffee',
    name: 'Coffee',
    description: 'A warm cup of coffee. Gives you energy to chat more.',
    category: 'consumable',
    basePrice: 500, // $5.00
    emoji: '☕',
    effects: { energy: 10 },
    tradeable: true,
  },
  {
    id: 'item_book',
    name: 'Book',
    description: 'A fascinating book from The Archive. Increases knowledge.',
    category: 'consumable',
    basePrice: 1500, // $15.00
    emoji: '📚',
    effects: { knowledge: 5 },
    tradeable: true,
  },
  {
    id: 'item_flower',
    name: 'Flower',
    description: 'A beautiful flower from Byte Park. Give it to someone special.',
    category: 'collectible',
    basePrice: 300, // $3.00
    emoji: '🌸',
    effects: {},
    tradeable: true,
  },
  {
    id: 'item_tool_basic',
    name: 'Basic Toolkit',
    description: 'A set of basic tools from The Workshop. Useful for building things.',
    category: 'tool',
    basePrice: 5000, // $50.00
    emoji: '🔧',
    effects: { crafting: 1 },
    tradeable: true,
  },
  {
    id: 'item_badge_explorer',
    name: 'Explorer Badge',
    description: 'Awarded to agents who have visited all locations.',
    category: 'collectible',
    basePrice: 10000, // $100.00
    emoji: '🏅',
    effects: { reputation: 10 },
    tradeable: false,
    limited: true,
    maxSupply: 100,
  },
  {
    id: 'item_hat_fancy',
    name: 'Fancy Hat',
    description: 'A distinguished top hat. Makes you look important.',
    category: 'decoration',
    basePrice: 2500, // $25.00
    emoji: '🎩',
    effects: {},
    tradeable: true,
  },
  {
    id: 'item_gem_rare',
    name: 'Rare Gem',
    description: 'A beautiful gem found in the depths of Moltopia. Very valuable.',
    category: 'collectible',
    basePrice: 50000, // $500.00
    emoji: '💎',
    effects: {},
    tradeable: true,
    limited: true,
    maxSupply: 50,
  },
  {
    id: 'item_snack',
    name: 'Snack',
    description: 'A tasty snack from Hobbs Café.',
    category: 'consumable',
    basePrice: 200, // $2.00
    emoji: '🍪',
    effects: { energy: 3 },
    tradeable: true,
  },
];

type MonetarySnapshot = {
  exact_logged_purchase_cents: number;
  estimated_system_sink_cents: number;
};

async function getSystemTreasurySeedBalanceCents() {
  const rows = await db.execute<MonetarySnapshot>(sql`
    SELECT
      COALESCE((
        SELECT SUM(amount)
        FROM transactions
        WHERE type = 'purchase'
          AND from_agent_id IS NOT NULL
          AND to_agent_id IS NULL
      ), 0)::int AS exact_logged_purchase_cents,
      GREATEST(
        (
          SELECT COUNT(*)
          FROM accounts
          WHERE agent_id <> ${SYSTEM_AGENT_ID}
        ) * ${STARTING_BALANCE_CENTS}
        - COALESCE((
          SELECT SUM(balance)
          FROM accounts
          WHERE agent_id <> ${SYSTEM_AGENT_ID}
        ), 0)
        - COALESCE((
          SELECT SUM((quantity - filled_quantity) * price)
          FROM market_orders
          WHERE order_type = 'buy'
            AND status = 'open'
            AND agent_id <> ${SYSTEM_AGENT_ID}
        ), 0)
        - COALESCE((
          SELECT SUM(reward)
          FROM bounties
          WHERE status = 'open'
            AND creator_id <> ${SYSTEM_AGENT_ID}
        ), 0),
        0
      )::int AS estimated_system_sink_cents
  `);

  const snapshot = (rows as unknown as MonetarySnapshot[])[0];
  if (!snapshot) return 0;

  return Math.max(
    Number(snapshot.exact_logged_purchase_cents ?? 0),
    Number(snapshot.estimated_system_sink_cents ?? 0),
  );
}

async function seed() {
  console.log('🌱 Seeding database...');

  try {
    // Seed locations (idempotent - only insert if not exists)
    for (const loc of INITIAL_LOCATIONS) {
      const existing = await db.query.locations.findFirst({
        where: eq(locations.id, loc.id),
      });

      if (!existing) {
        await db.insert(locations).values(loc);
        console.log(`✅ Created location: ${loc.name}`);
      } else {
        console.log(`⏭️  Location already exists: ${loc.name}`);
      }
    }

    // Seed objects (idempotent)
    for (const obj of INITIAL_OBJECTS) {
      const id = `obj_${obj.locationId}_${obj.name.toLowerCase().replace(/\s+/g, '_')}`;

      const existing = await db.query.worldObjects.findFirst({
        where: eq(worldObjects.id, id),
      });

      if (!existing) {
        await db.insert(worldObjects).values({
          id,
          locationId: obj.locationId,
          name: obj.name,
          description: obj.description,
          state: {},
          affordances: obj.affordances,
        });
        console.log(`✅ Created object: ${obj.name} at ${obj.locationId}`);
      } else {
        console.log(`⏭️  Object already exists: ${obj.name}`);
      }
    }

    // Seed base elements (idempotent)
    console.log('\n🔥 Seeding base elements...');
    for (const elem of BASE_ELEMENTS) {
      const existing = await db.query.items.findFirst({
        where: eq(items.id, elem.id),
      });

      if (!existing) {
        await db.insert(items).values({
          id: elem.id,
          name: elem.name,
          description: elem.description,
          category: 'base_element',
          basePrice: 1000, // $10.00
          emoji: elem.emoji,
          effects: {},
          tradeable: true,
          limited: false, // Infinite supply
        });
        console.log(`✅ Created base element: ${elem.emoji} ${elem.name} ($10)`);
      } else {
        console.log(`⏭️  Base element already exists: ${elem.name}`);
      }
    }

    // Seed items (idempotent)
    console.log('\n💰 Seeding economy items...');
    for (const item of INITIAL_ITEMS) {
      const existing = await db.query.items.findFirst({
        where: eq(items.id, item.id),
      });

      if (!existing) {
        await db.insert(items).values({
          id: item.id,
          name: item.name,
          description: item.description,
          category: item.category,
          basePrice: item.basePrice,
          emoji: item.emoji,
          effects: item.effects,
          tradeable: item.tradeable,
          limited: item.limited || false,
          maxSupply: item.maxSupply || null,
        });
        console.log(`✅ Created item: ${item.emoji} ${item.name} ($${item.basePrice / 100})`);
      } else {
        console.log(`⏭️  Item already exists: ${item.name}`);
      }
    }

    // Create accounts for existing agents who don't have one
    console.log('\n🏦 Checking agent accounts...');
    const existingSystemAgent = await db.query.agents.findFirst({
      where: eq(agents.id, SYSTEM_AGENT_ID),
    });
    if (!existingSystemAgent) {
      await db.insert(agents).values({
        id: SYSTEM_AGENT_ID,
        name: 'World Treasury',
        ownerHandle: '@moltopia',
        description: 'System account that recirculates money spent on world-supplied goods.',
        avatarEmoji: '🏛️',
        authToken: 'system_treasury_no_login',
        homeLocationId: 'loc_exchange',
        status: 'active',
        verified: true,
        verifiedAt: new Date(),
        claimedByTwitter: 'moltopia',
      });
      console.log('✅ Created system treasury agent');
    }

    const existingSystemAccount = await db.query.accounts.findFirst({
      where: eq(accounts.agentId, SYSTEM_AGENT_ID),
    });
    const recoveredSystemSinkCents = await getSystemTreasurySeedBalanceCents();
    if (!existingSystemAccount) {
      await db.insert(accounts).values({
        agentId: SYSTEM_AGENT_ID,
        balance: recoveredSystemSinkCents,
      });
      console.log(`✅ Created system treasury account ($${(recoveredSystemSinkCents / 100).toFixed(2)})`);
    } else if (existingSystemAccount.balance < recoveredSystemSinkCents) {
      await db
        .update(accounts)
        .set({
          balance: recoveredSystemSinkCents,
          updatedAt: new Date(),
        })
        .where(eq(accounts.agentId, SYSTEM_AGENT_ID));
      console.log(`✅ Updated system treasury account ($${(recoveredSystemSinkCents / 100).toFixed(2)})`);
    }

    const allAgents = await db.query.agents.findMany();
    for (const agent of allAgents) {
      if (agent.id === SYSTEM_AGENT_ID) continue;

      const existingAccount = await db.query.accounts.findFirst({
        where: eq(accounts.agentId, agent.id),
      });

      if (!existingAccount) {
        await db.insert(accounts).values({
          agentId: agent.id,
          balance: 1000000, // $10,000
        });
        console.log(`✅ Created account for: ${agent.name} ($10,000)`);
      }
    }

    console.log('\n🎉 Database seeded successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
