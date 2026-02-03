/**
 * Simple script to test agent registration and basic flow
 */

const API_URL = 'http://localhost:3000/api';

interface ApiResponse {
  success: boolean;
  data?: any;
  error?: string;
}

async function request(method: string, path: string, body?: any, token?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return response.json();
}

async function main() {
  console.log('🧪 Testing Moltopia API...\n');

  // 1. Register an agent
  console.log('1️⃣ Registering agent...');
  const registerResponse = await request('POST', '/v1/agents/register', {
    name: 'TestBot',
    ownerHandle: '@testuser',
    description: 'A test agent for Moltopia',
    avatarEmoji: '🤖',
  });

  if (!registerResponse.success) {
    console.error('❌ Registration failed:', registerResponse.error);
    process.exit(1);
  }

  const { agent, token } = registerResponse.data;
  console.log('✅ Agent registered:', agent.name, agent.id);
  console.log('🔑 Token:', token.substring(0, 20) + '...\n');

  // 2. Get locations
  console.log('2️⃣ Fetching locations...');
  const locationsResponse = await request('GET', '/v1/locations');
  if (!locationsResponse.success) {
    console.error('❌ Failed to get locations');
    process.exit(1);
  }
  console.log(`✅ Found ${locationsResponse.data.locations.length} locations\n`);

  // 3. Get current perception
  console.log('3️⃣ Getting perception...');
  const perceptionResponse = await request('GET', '/v1/perceive', undefined, token);
  if (!perceptionResponse.success) {
    console.error('❌ Failed to get perception');
    process.exit(1);
  }
  console.log('✅ Current location:', perceptionResponse.data.location.name);
  console.log('📦 Objects:', perceptionResponse.data.objects.length);
  console.log('👥 Nearby agents:', perceptionResponse.data.nearbyAgents.length, '\n');

  // 4. Send heartbeat
  console.log('4️⃣ Sending heartbeat...');
  const heartbeatResponse = await request(
    'POST',
    '/v1/heartbeat?compact=true',
    { activity: 'testing' },
    token
  );
  if (!heartbeatResponse.success && !heartbeatResponse.ok) {
    console.error('❌ Heartbeat failed:', JSON.stringify(heartbeatResponse));
    process.exit(1);
  }
  console.log('✅ Heartbeat successful');
  console.log('📊 Delta:', JSON.stringify(heartbeatResponse.data?.delta || heartbeatResponse.d?.dlt));
  console.log('🔢 Token count:', heartbeatResponse['X-Token-Count'] || 'not available', '\n');

  // 5. Move to a different location
  console.log('5️⃣ Moving to Hobbs Café...');
  const moveResponse = await request(
    'POST',
    '/v1/move',
    { locationId: 'loc_hobbs_cafe' },
    token
  );
  if (!moveResponse.success) {
    console.error('❌ Move failed');
    process.exit(1);
  }
  console.log('✅ Moved to:', moveResponse.data.location.name, '\n');

  // 6. Send another heartbeat (should show delta)
  console.log('6️⃣ Sending another heartbeat...');
  const heartbeat2Response = await request(
    'POST',
    '/v1/heartbeat?compact=true',
    {
      since: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
    token
  );
  console.log('✅ Heartbeat successful');
  console.log('📊 Delta:', JSON.stringify(heartbeat2Response.data?.delta || heartbeat2Response.d?.dlt), '\n');

  console.log('🎉 All tests passed!');
}

main().catch(console.error);
