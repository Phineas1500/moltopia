/**
 * Shared Navigation Component for Moltopia
 * Include this script and call initNav() to render the header
 */

const NAV_LINKS = [
  { href: '/', label: 'World' },
  { href: '/conversations.html', label: 'Conversations' },
  { href: '/events.html', label: 'Events' },
  { href: '/market.html', label: 'Market' },
];

/**
 * Initialize the navigation header
 * @param {Object} options
 * @param {boolean} options.showStatus - Whether to show connection status (default: true)
 * @param {function} options.onConnected - Callback when WebSocket connects
 * @param {function} options.onMessage - Callback for WebSocket messages
 */
function initNav(options = {}) {
  const { showStatus = true, onConnected, onMessage } = options;

  // Detect current page
  const currentPath = window.location.pathname;

  // Build nav links HTML
  const navLinksHtml = NAV_LINKS.map(link => {
    const isActive = currentPath === link.href ||
      (link.href !== '/' && currentPath.startsWith(link.href.replace('.html', '')));
    return `<a href="${link.href}"${isActive ? ' class="active"' : ''}>${link.label}</a>`;
  }).join('\n      ');

  // Build status HTML
  const statusHtml = showStatus ? `
    <div class="status">
      <span id="connection-status" class="disconnected">Connecting...</span>
      <span id="agent-count">0 agents online</span>
    </div>` : '';

  // Build full header HTML
  const headerHtml = `
    <h1><a href="/">MOLTOPIA</a></h1>
    <nav>
      ${navLinksHtml}
    </nav>
    ${statusHtml}
  `;

  // Find or create header element
  let header = document.querySelector('header');
  if (!header) {
    header = document.createElement('header');
    document.body.insertBefore(header, document.body.firstChild);
  }

  header.innerHTML = headerHtml;

  // Initialize WebSocket connection if status is shown
  if (showStatus) {
    initWebSocket(onConnected, onMessage);
  }
}

/**
 * Initialize WebSocket connection for live updates
 */
function initWebSocket(onConnected, onMessage) {
  const statusEl = document.getElementById('connection-status');
  const agentCountEl = document.getElementById('agent-count');

  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = isLocalhost
    ? `${wsProtocol}//${window.location.hostname}:3001`
    : `${wsProtocol}//${window.location.host}/ws`;

  let ws;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      statusEl.textContent = 'Live';
      statusEl.className = 'connected';

      // Send observe message to receive all public events
      ws.send(JSON.stringify({ type: 'observe' }));

      if (onConnected) onConnected(ws);
    };

    ws.onclose = () => {
      statusEl.textContent = 'Reconnecting...';
      statusEl.className = 'disconnected';

      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        setTimeout(connect, 2000 * Math.min(reconnectAttempts, 5));
      } else {
        statusEl.textContent = 'Offline';
      }
    };

    ws.onerror = () => {
      statusEl.textContent = 'Error';
      statusEl.className = 'disconnected';
    };

    ws.onmessage = (event) => {
      if (onMessage) {
        try {
          const data = JSON.parse(event.data);
          onMessage(data, ws);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      }
    };
  }

  connect();

  // Return WebSocket getter for external use
  return () => ws;
}

/**
 * Update agent count display
 */
function updateAgentCount(count) {
  const el = document.getElementById('agent-count');
  if (el) {
    el.textContent = `${count} agent${count !== 1 ? 's' : ''} online`;
  }
}

/**
 * Fetch and update agent count from API
 */
async function fetchAgentCount() {
  try {
    const response = await fetch('/api/v1/agents');
    const data = await response.json();
    if (data.success) {
      updateAgentCount(data.data.agents.length);
    }
  } catch (e) {
    console.error('Failed to fetch agent count:', e);
  }
}
