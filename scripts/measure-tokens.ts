/**
 * Script to measure token counts for all endpoints
 * Validates that we're meeting our efficiency targets
 */

import { countJSONTokens } from '../src/utils/token-counter.js';

const API_URL = 'http://localhost:3000/api';

interface TokenMeasurement {
  endpoint: string;
  method: string;
  compact: boolean;
  tokens: number;
  target: number;
  status: 'PASS' | 'FAIL';
}

async function request(method: string, path: string, body?: any, token?: string, compact = false): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = compact ? `${API_URL}${path}?compact=true` : `${API_URL}${path}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return response.json();
}

async function measureEndpoint(
  name: string,
  method: string,
  path: string,
  body: any,
  token: string | undefined,
  target: number
): Promise<TokenMeasurement> {
  // Measure both standard and compact
  const standard = await request(method, path, body, token, false);
  const compact = await request(method, path, body, token, true);

  const standardTokens = countJSONTokens(standard);
  const compactTokens = countJSONTokens(compact);

  console.log(`\n${name}:`);
  console.log(`  Standard: ${standardTokens} tokens`);
  console.log(`  Compact:  ${compactTokens} tokens (${Math.round((1 - compactTokens/standardTokens) * 100)}% reduction)`);
  console.log(`  Target:   ${target} tokens`);
  console.log(`  Status:   ${compactTokens <= target ? '✅ PASS' : '❌ FAIL'}`);

  return {
    endpoint: name,
    method,
    compact: true,
    tokens: compactTokens,
    target,
    status: compactTokens <= target ? 'PASS' : 'FAIL',
  };
}

async function main() {
  console.log('📊 Measuring Token Counts for All Endpoints\n');
  console.log('='.repeat(50));

  const measurements: TokenMeasurement[] = [];

  // 1. Register agent
  console.log('\n1️⃣ Registering test agent...');
  const registerResponse = await request('POST', '/v1/agents/register', {
    name: 'TokenTestBot',
    ownerHandle: '@tokentest',
    description: 'Testing token efficiency',
  });

  const { token } = registerResponse.data;

  measurements.push(await measureEndpoint(
    'Agent Registration',
    'POST',
    '/v1/agents/register',
    { name: 'Test', ownerHandle: '@test' },
    undefined,
    200  // Target
  ));

  // 2. List locations
  measurements.push(await measureEndpoint(
    'List Locations',
    'GET',
    '/v1/locations',
    undefined,
    undefined,
    300  // Target
  ));

  // 3. Get perception
  measurements.push(await measureEndpoint(
    'Get Perception',
    'GET',
    '/v1/perceive',
    undefined,
    token,
    200  // Target
  ));

  // 4. Heartbeat (no changes)
  measurements.push(await measureEndpoint(
    'Heartbeat (no change)',
    'POST',
    '/v1/heartbeat',
    { since: new Date().toISOString() },
    token,
    30  // ⭐ CRITICAL TARGET
  ));

  // 5. Move
  measurements.push(await measureEndpoint(
    'Move Location',
    'POST',
    '/v1/move',
    { locationId: 'loc_hobbs_cafe' },
    token,
    150  // Target
  ));

  // 6. Heartbeat (with changes)
  await new Promise(resolve => setTimeout(resolve, 1000));  // Wait a second
  measurements.push(await measureEndpoint(
    'Heartbeat (with delta)',
    'POST',
    '/v1/heartbeat',
    { since: new Date(Date.now() - 10000).toISOString() },
    token,
    100  // Target
  ));

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('\n📈 Summary:\n');

  const passed = measurements.filter(m => m.status === 'PASS').length;
  const failed = measurements.filter(m => m.status === 'FAIL').length;

  console.log(`Total Endpoints: ${measurements.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);

  console.log('\n📋 Detailed Results:\n');
  console.table(measurements.map(m => ({
    Endpoint: m.endpoint,
    Tokens: m.tokens,
    Target: m.target,
    Status: m.status
  })));

  if (failed > 0) {
    console.log('\n⚠️  Some endpoints exceeded token targets!');
    process.exit(1);
  } else {
    console.log('\n🎉 All endpoints meet token efficiency targets!');
  }
}

main().catch(console.error);
