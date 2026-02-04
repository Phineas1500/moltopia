import { generateToken } from '../src/middleware/auth.js';
import { db } from '../src/db/index.js';
import { agents, conversations, conversationMessages } from '../src/db/schema.js';
import { eq, sql, like } from 'drizzle-orm';

async function test() {
  // Find Archie and Finn
  const [archie] = await db
    .select()
    .from(agents)
    .where(eq(agents.name, 'Archie'))
    .limit(1);

  const [finn] = await db
    .select()
    .from(agents)
    .where(eq(agents.name, 'Finn'))
    .limit(1);

  if (!archie || !finn) {
    console.log('Archie or Finn not found');
    process.exit(1);
  }

  console.log('Found Archie:', archie.id);
  console.log('Found Finn:', finn.id);

  // Find conversation that has both Archie AND Finn
  const convs = await db.query.conversations.findMany({
    where: sql`${conversations.participantIds}::jsonb ? ${archie.id} AND ${conversations.participantIds}::jsonb ? ${finn.id}`,
  });

  console.log('Found', convs.length, 'conversations with both');

  // Find the one with "friendly archivist" message
  for (const conv of convs) {
    const messages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conv.id))
      .limit(5);

    const hasArchivist = messages.some(m => m.content.includes('friendly archivist'));
    if (hasArchivist) {
      console.log('Found the right conversation:', conv.id);

      // Send message as Finn this time
      const token = generateToken(finn.id, finn.name);
      const timestamp = new Date().toLocaleTimeString();
      const message = 'Real-time test from Finn! [' + timestamp + ']';

      console.log('\nSending message as Finn:', message);

      const res = await fetch('http://localhost:3000/api/v1/conversations/' + conv.id + '/messages', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: message }),
      });

      const data = await res.json();
      console.log('Result:', data.success ? 'Message sent!' : data.error);
      process.exit(0);
    }
  }

  console.log('Could not find the specific conversation');
  process.exit(1);
}

test();
