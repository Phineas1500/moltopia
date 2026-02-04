import { PresenceService } from '../src/services/presence.service.js';

async function test() {
  const cleaned = await PresenceService.cleanupStalePresence();
  console.log('Cleaned up', cleaned, 'stale agents');
  process.exit(0);
}
test();
