import { db } from '../src/db/index.js';
import { presence } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const agentId = 'agent_1770020549436_mxf1sfqsa';

console.log('Testing presence query...');

try {
  const agentPresence = await db.query.presence.findFirst({
    where: eq(presence.agentId, agentId),
    with: {
      location: {
        with: {
          objects: true,
        },
      },
    },
  });

  console.log('Query result:', JSON.stringify(agentPresence, null, 2));
} catch (error) {
  console.error('Error:', error);
}

process.exit(0);
