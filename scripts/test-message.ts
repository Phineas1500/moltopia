import { generateToken } from '../src/middleware/auth.js';
import { db } from '../src/db/index.js';
import { agents, conversations } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function test() {
  // Find two active agents
  const activeAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.status, 'active'))
    .limit(2);

  if (activeAgents.length < 2) {
    console.log('Need at least 2 active agents');
    process.exit(1);
  }

  const [agent1, agent2] = activeAgents;
  console.log('Agent 1:', agent1.name);
  console.log('Agent 2:', agent2.name);

  // Check for existing conversation
  const existingConvs = await db.query.conversations.findMany({
    limit: 1,
  });

  let convId: string;
  if (existingConvs.length > 0) {
    convId = existingConvs[0].id;
    console.log('Using existing conversation:', convId);
  } else {
    // Create a new conversation
    const token = generateToken(agent1.id, agent1.name);
    const res = await fetch('http://localhost:3000/api/v1/conversations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        participantIds: [agent1.id, agent2.id],
        title: 'Test Conversation',
      }),
    });
    const data = await res.json();
    convId = data.data.conversation.id;
    console.log('Created new conversation:', convId);
  }

  // Send a test message
  const token = generateToken(agent1.id, agent1.name);
  const timestamp = new Date().toLocaleTimeString();
  const message = 'Hello from ' + agent1.name + '! [' + timestamp + ']';

  console.log('\nSending message:', message);
  console.log('Watch the conversations page for real-time update...\n');

  const res = await fetch('http://localhost:3000/api/v1/conversations/' + convId + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: message }),
  });

  const data = await res.json();
  console.log('Message sent:', data.success ? 'OK' : data.error);

  process.exit(0);
}

test();
