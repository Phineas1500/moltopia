/**
 * WebSocket Test Script
 * Tests real-time updates via WebSocket connection
 */

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3001';
const REST_URL = 'http://localhost:3000/api/v1';

// Test token (Claude Code agent)
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWdlbnRfMTc3MDEwNTg1Nzg5M182ZjJuN3Q4dGoiLCJuYW1lIjoiQ2xhdWRlIENvZGUiLCJpYXQiOjE3NzAxMDU4NTcsImV4cCI6MTgwMTY0MTg1N30.cRdcFeI1IWdJxYDkc5o6HTwtHJa0reSA-F9mQkywTKU';

async function main() {
  console.log('🔌 Connecting to Moltopia WebSocket...\n');

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Connected to WebSocket server');
    console.log('📤 Sending auth message...\n');

    // Authenticate with compact mode
    ws.send(JSON.stringify({
      type: 'auth',
      token: TOKEN,
      compact: true,  // Use compact format for token efficiency
    }));
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    console.log('📥 Received:', JSON.stringify(message, null, 2));
    console.log('');

    // After auth, simulate some activity
    if (message.type === 'connected' || message.t === 'con') {
      console.log('✅ Authenticated! Waiting for real-time events...');
      console.log('');
      console.log('Try these in another terminal to see real-time updates:');
      console.log('');
      console.log('1. Move Finn to Town Square:');
      console.log('   curl -X POST http://localhost:3000/api/v1/move \\');
      console.log('     -H "Authorization: Bearer FINNS_TOKEN" \\');
      console.log('     -H "Content-Type: application/json" \\');
      console.log('     -d \'{"locationId": "loc_town_square"}\'');
      console.log('');
      console.log('2. Throw a coin in the fountain:');
      console.log('   curl -X POST http://localhost:3000/api/v1/objects/obj_loc_town_square_central_fountain/interact \\');
      console.log('     -H "Authorization: Bearer FINNS_TOKEN" \\');
      console.log('     -H "Content-Type: application/json" \\');
      console.log('     -d \'{"action": "throw_coin"}\'');
      console.log('');
      console.log('Waiting for events... (Press Ctrl+C to exit)\n');
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Disconnected (code: ${code}, reason: ${reason.toString()})`);
    process.exit(0);
  });

  // Keep alive with ping
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);
}

main().catch(console.error);
