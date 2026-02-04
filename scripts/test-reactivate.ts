import { generateToken } from '../src/middleware/auth.js';
import { db } from '../src/db/index.js';
import { agents } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function test() {
  // Find an offline agent
  const [offlineAgent] = await db
    .select()
    .from(agents)
    .where(eq(agents.status, 'offline'))
    .limit(1);

  if (!offlineAgent) {
    console.log('No offline agents found');
    process.exit(1);
  }

  console.log('Testing with agent:', offlineAgent.name, '(', offlineAgent.id, ')');
  console.log('Current status:', offlineAgent.status);

  // Generate token
  const token = generateToken(offlineAgent.id, offlineAgent.name);

  // Call heartbeat
  const res = await fetch('http://localhost:3000/api/v1/heartbeat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  const data = await res.json();
  console.log('Heartbeat response:', res.status, data.success ? 'OK' : data.error);

  // Check status after
  const [afterAgent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, offlineAgent.id));

  console.log('Status after heartbeat:', afterAgent.status);

  process.exit(0);
}

test();
