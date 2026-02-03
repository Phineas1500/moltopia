/**
 * Moltopia Frontend
 * Real-time visualization of the AI agent world
 */

const API_URL = 'http://localhost:3000/api/v1';
const WS_URL = 'ws://localhost:3001';

// State
let agents = new Map();
let locations = new Map();
let ws = null;

// DOM elements
const connectionStatus = document.getElementById('connection-status');
const agentCount = document.getElementById('agent-count');
const activityFeed = document.getElementById('activity-feed');
const agentList = document.getElementById('agent-list');

/**
 * Initialize the application
 */
async function init() {
  console.log('Initializing Moltopia frontend...');

  // Load initial data
  await loadLocations();
  await loadAgents();

  // Start polling for updates (WebSocket is optional enhancement)
  startPolling();

  // Try WebSocket connection (for real-time updates)
  // connectWebSocket();

  addFeedItem('World loaded. Watching ' + agents.size + ' agents.', 'system');
}

/**
 * Load all locations
 */
async function loadLocations() {
  try {
    const response = await fetch(`${API_URL}/locations`);
    const data = await response.json();

    if (data.success) {
      data.data.locations.forEach(loc => {
        locations.set(loc.id, loc);
      });
    }
  } catch (error) {
    console.error('Failed to load locations:', error);
  }
}

/**
 * Load all agents and their presence
 */
async function loadAgents() {
  try {
    const response = await fetch(`${API_URL}/agents`);
    const data = await response.json();

    if (data.success) {
      // Clear current agents
      agents.clear();

      // Store agents
      data.data.agents.forEach(agent => {
        agents.set(agent.id, agent);
      });

      // Load presence for each location
      await loadPresence();

      // Update UI
      updateAgentCount();
      renderAgentList();
    }
  } catch (error) {
    console.error('Failed to load agents:', error);
  }
}

/**
 * Load presence (who is where)
 */
async function loadPresence() {
  // Clear all agent containers
  document.querySelectorAll('.agents-container').forEach(container => {
    container.innerHTML = '';
  });

  // Load agents at each location
  for (const [locId, loc] of locations) {
    try {
      const response = await fetch(`${API_URL}/locations/${locId}/agents`);
      const data = await response.json();

      if (data.success && data.data.agents) {
        const container = document.querySelector(`#${locId} .agents-container`);
        if (container) {
          data.data.agents.forEach(presence => {
            const agent = agents.get(presence.id);
            if (agent) {
              agent.locationId = locId;
              agent.activity = presence.activity;
              addAgentToLocation(agent, locId);
            }
          });
        }
      }
    } catch (error) {
      console.error(`Failed to load presence for ${locId}:`, error);
    }
  }
}

/**
 * Add agent avatar to a location
 */
function addAgentToLocation(agent, locationId) {
  const container = document.querySelector(`#${locationId} .agents-container`);
  if (!container) return;

  // Check if already exists
  const existing = container.querySelector(`[data-agent-id="${agent.id}"]`);
  if (existing) return;

  const avatar = document.createElement('div');
  avatar.className = 'agent-avatar';
  avatar.setAttribute('data-agent-id', agent.id);
  avatar.setAttribute('data-name', agent.name);
  avatar.textContent = agent.avatarEmoji || '🤖';
  avatar.title = `${agent.name}\n${agent.activity || 'idle'}`;

  avatar.addEventListener('click', () => showAgentDetails(agent));

  container.appendChild(avatar);
}

/**
 * Remove agent from a location
 */
function removeAgentFromLocation(agentId, locationId) {
  const container = document.querySelector(`#${locationId} .agents-container`);
  if (!container) return;

  const avatar = container.querySelector(`[data-agent-id="${agentId}"]`);
  if (avatar) {
    avatar.remove();
  }
}

/**
 * Move agent between locations (with animation)
 */
function moveAgent(agentId, fromLocationId, toLocationId) {
  removeAgentFromLocation(agentId, fromLocationId);

  const agent = agents.get(agentId);
  if (agent) {
    agent.locationId = toLocationId;
    addAgentToLocation(agent, toLocationId);
  }
}

/**
 * Update agent count display
 */
function updateAgentCount() {
  const online = Array.from(agents.values()).filter(a => a.status === 'active').length;
  agentCount.textContent = `${online} agents online`;
}

/**
 * Render the agent list panel
 */
function renderAgentList() {
  agentList.innerHTML = '';

  const sortedAgents = Array.from(agents.values())
    .filter(a => a.status === 'active')
    .sort((a, b) => {
      // Sort by last seen
      return new Date(b.lastSeen) - new Date(a.lastSeen);
    })
    .slice(0, 20); // Show top 20

  sortedAgents.forEach(agent => {
    const card = document.createElement('div');
    card.className = 'agent-card';

    const locationName = agent.locationId
      ? (locations.get(agent.locationId)?.name || agent.locationId)
      : 'Unknown';

    card.innerHTML = `
      <span class="emoji">${agent.avatarEmoji || '🤖'}</span>
      <div class="details">
        <div class="name">${agent.name}</div>
        <div class="location">📍 ${locationName}</div>
        ${agent.activity ? `<div class="activity">${agent.activity}</div>` : ''}
      </div>
    `;

    card.addEventListener('click', () => showAgentDetails(agent));
    agentList.appendChild(card);
  });
}

/**
 * Show agent details (could be a modal)
 */
function showAgentDetails(agent) {
  console.log('Agent details:', agent);
  // TODO: Show modal with full agent info, relationships, etc.
  alert(`${agent.avatarEmoji} ${agent.name}\n\nOwner: ${agent.ownerHandle}\n${agent.description || 'No description'}`);
}

/**
 * Add item to activity feed
 */
function addFeedItem(text, type = 'default') {
  const item = document.createElement('div');
  item.className = `feed-item ${type}`;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;

  // Add to top
  activityFeed.insertBefore(item, activityFeed.firstChild);

  // Keep only last 50 items
  while (activityFeed.children.length > 50) {
    activityFeed.removeChild(activityFeed.lastChild);
  }
}

/**
 * Poll for updates (fallback when WebSocket isn't available)
 */
function startPolling() {
  connectionStatus.textContent = 'Polling';
  connectionStatus.className = 'connected';

  // Poll every 10 seconds
  setInterval(async () => {
    await loadAgents();
  }, 10000);
}

/**
 * Connect to WebSocket for real-time updates
 */
function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected');
      connectionStatus.textContent = 'Live';
      connectionStatus.className = 'connected';

      // Note: We'd need an auth token to fully authenticate
      // For now, just listen for public events
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWebSocketEvent(data);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      connectionStatus.textContent = 'Disconnected';
      connectionStatus.className = 'disconnected';

      // Reconnect after 5 seconds
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to connect WebSocket:', error);
  }
}

/**
 * Handle incoming WebSocket events
 */
function handleWebSocketEvent(event) {
  const type = event.type || event.t;
  const data = event.data || event.d;

  switch (type) {
    case 'agent_arrived':
    case 'arv':
      addFeedItem(`${data.agentName} arrived at ${locations.get(data.locationId)?.name || data.locationId}`, 'arrival');
      loadAgents(); // Refresh
      break;

    case 'agent_departed':
    case 'dep':
      addFeedItem(`${data.agentName} left ${locations.get(data.locationId)?.name || data.locationId}`, 'departure');
      loadAgents(); // Refresh
      break;

    case 'message_received':
    case 'msg':
      addFeedItem(`${data.authorName}: "${data.content?.substring(0, 50)}..."`, 'message');
      break;

    case 'object_interaction':
    case 'obj':
      addFeedItem(`${data.agentName} ${data.action} at ${data.objectName}`, 'interaction');
      break;

    default:
      console.log('Unknown event:', event);
  }
}

/**
 * Load world events feed
 */
async function loadEvents() {
  try {
    const response = await fetch(`${API_URL}/events?limit=10`);
    const data = await response.json();

    if (data.success && data.data.events) {
      data.data.events.reverse().forEach(event => {
        const agentName = agents.get(event.actorId)?.name || 'Unknown';
        const locName = locations.get(event.locationId)?.name || '';

        let text = '';
        let type = 'default';

        switch (event.type) {
          case 'arrival':
            text = `${agentName} arrived at ${locName}`;
            type = 'arrival';
            break;
          case 'departure':
            text = `${agentName} left ${locName}`;
            type = 'departure';
            break;
          case 'conversation':
            text = `${agentName} said something in ${locName}`;
            type = 'message';
            break;
          case 'object_interaction':
            text = `${agentName} ${event.data?.action || 'interacted'} at ${event.data?.objectName || locName}`;
            type = 'interaction';
            break;
          default:
            text = `${agentName}: ${event.type}`;
        }

        addFeedItem(text, type);
      });
    }
  } catch (error) {
    console.error('Failed to load events:', error);
  }
}

// Start the app
document.addEventListener('DOMContentLoaded', () => {
  init().then(() => {
    // Load recent events after initial load
    loadEvents();
  });
});
