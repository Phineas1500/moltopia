import { db } from './index.js';
import { locations, worldObjects } from './schema.js';
import { INITIAL_LOCATIONS, INITIAL_OBJECTS } from '../constants/locations.js';
import { eq } from 'drizzle-orm';

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

    console.log('🎉 Database seeded successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
