// ExodusXE Extension Popup
const SERVER_URL = 'https://female-valentine-hearing-boats.trycloudflare.com';

let ws = null;
let roomId = null;
let wsUrl = null;
let currentProfile = 'universal';

// Ensure WebSocket URL uses wss://
function ensureWss(url) {
  if (url && url.startsWith('ws://')) {
    return url.replace('ws://', 'wss://');
  }
  return url;
}

const profileMappings = {
  universal: { 'D-Pad': 'Arrows', 'A': 'Enter', 'B': 'Escape', 'X': 'Space', 'Y': 'Tab' },
  presentation: { 'Swipe →': 'Next', 'Swipe ←': 'Previous', 'Tap': 'Next', 'A': 'Enter', 'B': 'Escape' },
  video: { 'Play': 'Space', 'Seek': '←/→', 'Volume': '↑/↓', 'Mute': 'M', 'Fullscreen': 'F' },
  meeting: { 'Mute': '⌘D', 'Video': '⌘E', 'Chat': '⌘H', 'Raise': 'Y', 'Leave': '⌘W' },
  scroll: { 'Scroll': '↑/↓', 'Page': 'PgUp/Dn', 'Top': 'Home', 'Bottom': 'End', 'Back': 'Alt←' },
  mouse: { 'Motion': 'Cursor', 'Tap': 'Click', 'Hold': 'Right Click', 'Double': 'Double Click' }
};

async function init() {
  // Check for existing session first
  const stored = await chrome.storage.local.get(['roomId', 'wsUrl', 'profile']);

  if (stored.roomId && stored.wsUrl) {
    console.log('ExodusXE: Reusing existing session:', stored.roomId);
    roomId = stored.roomId;
    wsUrl = ensureWss(stored.wsUrl);
    currentProfile = stored.profile || 'universal';

    showConnected();
    connectWS(wsUrl);
    // Always notify content script to ensure it's on the right room
    notifyContentScript();
    return;
  }

  // No existing session, create new room
  await createNewRoom();
}

async function createNewRoom() {
  try {
    const res = await fetch(`${SERVER_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: currentProfile })
    });
    const data = await res.json();
    roomId = data.roomId;
    wsUrl = ensureWss(data.websocketUrl);

    // Store for content script (always use wss://)
    await chrome.storage.local.set({ roomId, wsUrl, profile: currentProfile });

    showConnected();
    connectWS(wsUrl);

    // Tell content script to connect
    notifyContentScript();

  } catch (e) {
    console.error('Failed to create room:', e);
    document.getElementById('loading').innerHTML =
      '<p style="color:#f66;font-size:11px;">Connection failed.<br>Check if server is running.</p>';
  }
}

function showConnected() {
  const controllerUrl = `${SERVER_URL}/remote/${roomId}`;
  document.getElementById('qrCode').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(controllerUrl)}`;
  document.getElementById('roomCode').textContent = roomId;

  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';

  // Set profile dropdown to current
  document.getElementById('profileSelect').value = currentProfile;
  updateMappingPreview();
}

function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'connect',
        roomId,
        wsUrl,
        profile: currentProfile
      }).catch(() => {});
    }
  });
}

function connectWS(url) {
  if (ws) {
    ws.close();
  }

  ws = new WebSocket(url);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomId, role: 'display' }));
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'joined' || data.type === 'status') {
      const connected = data.controllers > 0;
      document.getElementById('statusDot').className = 'status-dot' + (connected ? ' connected' : '');
      document.getElementById('statusText').textContent = connected ? 'Phone connected' : 'Waiting for phone';
    }
  };

  ws.onclose = () => {
    // Only reconnect if popup is still open
    setTimeout(() => {
      if (document.visibilityState !== 'hidden') {
        connectWS(url);
      }
    }, 2000);
  };
}

function updateMappingPreview() {
  const grid = document.getElementById('mappingGrid');
  const mappings = profileMappings[currentProfile];
  grid.innerHTML = '';

  Object.entries(mappings).forEach(([action, key]) => {
    grid.innerHTML += `
      <div class="mapping-item">
        <span>${action}</span>
        <span class="mapping-key">${key}</span>
      </div>
    `;
  });
}

function changeProfile() {
  currentProfile = document.getElementById('profileSelect').value;
  updateMappingPreview();

  // Send to server (which broadcasts to phone controller)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'setProfile', profile: currentProfile }));
    console.log('Sent profile change to server:', currentProfile);
  }

  chrome.storage.local.set({ profile: currentProfile });

  // Update content script on current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'setProfile',
        profile: currentProfile
      }).catch(() => {});
    }
  });
}

function reconnect() {
  if (ws) ws.close();
  // Clear old session
  chrome.storage.local.remove(['roomId', 'wsUrl']);
  document.getElementById('loading').style.display = 'block';
  document.getElementById('main').style.display = 'none';
  createNewRoom();
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Add event listeners (CSP-compliant, no inline handlers)
  document.getElementById('profileSelect').addEventListener('change', changeProfile);
  document.getElementById('reconnectBtn').addEventListener('click', reconnect);

  // Start initialization
  init();
});
