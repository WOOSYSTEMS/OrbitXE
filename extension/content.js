// ExodusXE Content Script - Universal Web Remote

let ws = null;
let currentProfile = 'universal';
let isConnected = false;
let currentRoomId = null;
let currentWsUrl = null;
let intentionalClose = false;

// Profile-based key mappings
const profiles = {
  universal: {
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    a: { key: 'Enter', code: 'Enter', keyCode: 13 },
    b: { key: 'Escape', code: 'Escape', keyCode: 27 },
    x: { key: ' ', code: 'Space', keyCode: 32 },
    y: { key: 'Tab', code: 'Tab', keyCode: 9 }
  },
  presentation: {
    swipeLeft: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    swipeRight: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    swipeUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    swipeDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    tap: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    a: { key: 'Enter', code: 'Enter', keyCode: 13 },
    b: { key: 'Escape', code: 'Escape', keyCode: 27 }
  },
  video: {
    play: { key: ' ', code: 'Space', keyCode: 32 },
    mute: { key: 'm', code: 'KeyM', keyCode: 77 },
    fullscreen: { key: 'f', code: 'KeyF', keyCode: 70 },
    seekBack: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    seekForward: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    volumeUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    volumeDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    captions: { key: 'c', code: 'KeyC', keyCode: 67 }
  },
  meeting: {
    // These vary by platform, using common Zoom shortcuts
    mute: { key: 'd', code: 'KeyD', keyCode: 68, meta: true },
    video: { key: 'e', code: 'KeyE', keyCode: 69, meta: true },
    chat: { key: 'h', code: 'KeyH', keyCode: 72, meta: true, shift: true },
    raise: { key: 'y', code: 'KeyY', keyCode: 89 },
    leave: { key: 'w', code: 'KeyW', keyCode: 87, meta: true }
  },
  scroll: {
    scrollUp: { type: 'scroll', y: -300 },
    scrollDown: { type: 'scroll', y: 300 },
    pageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    top: { key: 'Home', code: 'Home', keyCode: 36 },
    bottom: { key: 'End', code: 'End', keyCode: 35 },
    back: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
    forward: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, alt: true }
  },
  mouse: {
    // Mouse mode handled separately
  }
};

// Site-specific handlers
const siteHandlers = {
  // YouTube
  'youtube.com': {
    play: () => {
      const video = document.querySelector('video');
      if (video) video.paused ? video.play() : video.pause();
    },
    seekForward: () => {
      const video = document.querySelector('video');
      if (video) video.currentTime += 10;
    },
    seekBack: () => {
      const video = document.querySelector('video');
      if (video) video.currentTime -= 10;
    },
    volumeUp: () => {
      const video = document.querySelector('video');
      if (video) video.volume = Math.min(1, video.volume + 0.1);
    },
    volumeDown: () => {
      const video = document.querySelector('video');
      if (video) video.volume = Math.max(0, video.volume - 0.1);
    },
    mute: () => {
      const video = document.querySelector('video');
      if (video) video.muted = !video.muted;
    },
    fullscreen: () => {
      const btn = document.querySelector('.ytp-fullscreen-button');
      if (btn) btn.click();
    },
    up: () => window.scrollBy({ top: -300, behavior: 'smooth' }),
    down: () => window.scrollBy({ top: 300, behavior: 'smooth' }),
    left: () => {
      const video = document.querySelector('video');
      if (video) video.currentTime -= 5;
    },
    right: () => {
      const video = document.querySelector('video');
      if (video) video.currentTime += 5;
    },
    a: () => {
      const video = document.querySelector('video');
      if (video) video.paused ? video.play() : video.pause();
    },
    x: () => {
      const video = document.querySelector('video');
      if (video) video.paused ? video.play() : video.pause();
    }
  },
  // Netflix
  'netflix.com': {
    play: () => {
      const video = document.querySelector('video');
      if (video) video.paused ? video.play() : video.pause();
    },
    seekForward: () => {
      const video = document.querySelector('video');
      if (video) video.currentTime += 10;
    },
    seekBack: () => {
      const video = document.querySelector('video');
      if (video) video.currentTime -= 10;
    }
  }
};

// Get current site handler
function getSiteHandler() {
  const host = window.location.hostname;
  for (const site in siteHandlers) {
    if (host.includes(site)) return siteHandlers[site];
  }
  return null;
}

// Auto-detect best profile for current site
function detectSiteProfile() {
  const host = window.location.hostname;
  const path = window.location.pathname;

  // Video sites
  if (host.includes('youtube.com') || host.includes('netflix.com') ||
      host.includes('vimeo.com') || host.includes('twitch.tv') ||
      host.includes('disneyplus.com') || host.includes('hulu.com') ||
      host.includes('primevideo.com')) {
    return 'video';
  }

  // Presentation sites
  if (host.includes('docs.google.com') && path.includes('/presentation')) {
    return 'presentation';
  }
  if (host.includes('slides.google.com') || host.includes('prezi.com') ||
      host.includes('canva.com') && path.includes('/design')) {
    return 'presentation';
  }

  // Meeting sites
  if (host.includes('zoom.us') || host.includes('meet.google.com') ||
      host.includes('teams.microsoft.com') || host.includes('webex.com')) {
    return 'meeting';
  }

  // Reading/article sites
  if (host.includes('medium.com') || host.includes('reddit.com') ||
      host.includes('news.ycombinator.com') || host.includes('wikipedia.org') ||
      host.includes('substack.com')) {
    return 'scroll';
  }

  return 'universal';
}

// Send detected profile to server/phone
function broadcastDetectedProfile() {
  const detectedProfile = detectSiteProfile();
  console.log('ExodusXE: Auto-detected profile:', detectedProfile);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'siteDetected',
      profile: detectedProfile,
      site: window.location.hostname
    }));
  }
}

// Simulate keyboard event - multiple methods for compatibility
function simulateKey(mapping, action) {
  if (!mapping) return;

  console.log('ExodusXE: Simulating key', mapping, 'action:', action);

  // Try site-specific handler first
  const handler = getSiteHandler();
  if (handler && handler[action]) {
    console.log('ExodusXE: Using site-specific handler for', action);
    handler[action]();
    return;
  }

  // Handle scroll action
  if (mapping.type === 'scroll') {
    window.scrollBy({ top: mapping.y, behavior: 'smooth' });
    return;
  }

  // Generic scroll for arrow keys
  if (mapping.key === 'ArrowDown') {
    window.scrollBy({ top: 100, behavior: 'smooth' });
  } else if (mapping.key === 'ArrowUp') {
    window.scrollBy({ top: -100, behavior: 'smooth' });
  }

  const target = document.activeElement || document.body;

  // Method 1: KeyboardEvent
  const keydownEvent = new KeyboardEvent('keydown', {
    key: mapping.key,
    code: mapping.code,
    keyCode: mapping.keyCode,
    which: mapping.keyCode,
    bubbles: true,
    cancelable: true,
    view: window,
    metaKey: mapping.meta || false,
    ctrlKey: mapping.ctrl || false,
    altKey: mapping.alt || false,
    shiftKey: mapping.shift || false
  });

  // Dispatch to multiple targets
  document.dispatchEvent(keydownEvent);
  document.body.dispatchEvent(keydownEvent);
  target.dispatchEvent(keydownEvent);
  window.dispatchEvent(keydownEvent);

  // Fire keyup after short delay
  setTimeout(() => {
    const keyupEvent = new KeyboardEvent('keyup', {
      key: mapping.key,
      code: mapping.code,
      keyCode: mapping.keyCode,
      which: mapping.keyCode,
      bubbles: true,
      cancelable: true,
      view: window
    });
    document.dispatchEvent(keyupEvent);
    document.body.dispatchEvent(keyupEvent);
    target.dispatchEvent(keyupEvent);
  }, 100);
}

// Handle action from remote
function handleAction(action) {
  console.log('ExodusXE: Received action:', action, 'Profile:', currentProfile);

  // Try site-specific handler first (works regardless of profile)
  const handler = getSiteHandler();
  if (handler && handler[action]) {
    console.log('ExodusXE: Using site-specific handler for', action);
    handler[action]();
    flashIndicator(action);
    return;
  }

  // Fall back to profile mapping
  const mapping = profiles[currentProfile]?.[action];
  console.log('ExodusXE: Mapping found:', mapping);
  if (mapping) {
    simulateKey(mapping, action);
    flashIndicator(action);
  } else {
    console.log('ExodusXE: No mapping for action:', action);
    flashIndicator('?' + action);
  }
}

// Handle gesture from remote
function handleGesture(gesture, data) {
  const mapping = profiles[currentProfile]?.[gesture];
  if (mapping) {
    simulateKey(mapping, gesture);
    flashIndicator(gesture);
  }
}

// Handle mouse motion
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;

function handleMotion(x, y) {
  if (currentProfile !== 'mouse') return;

  // Convert tilt to mouse movement
  mouseX += x * 2;
  mouseY += y * 2;

  // Clamp to window
  mouseX = Math.max(0, Math.min(window.innerWidth, mouseX));
  mouseY = Math.max(0, Math.min(window.innerHeight, mouseY));

  // Move cursor indicator
  updateCursorIndicator(mouseX, mouseY);
}

// Visual feedback
let indicator = null;
let cursorIndicator = null;

function createIndicator() {
  if (indicator) return;

  indicator = document.createElement('div');
  indicator.id = 'exodusxe-indicator';
  indicator.innerHTML = `
    <div style="
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(0,0,0,0.9);
      color: #fff;
      padding: 8px 16px;
      border-radius: 24px;
      font-family: -apple-system, sans-serif;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      z-index: 2147483647;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      transition: all 0.2s;
    ">
      <div id="exodusxe-dot" style="
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #333;
        transition: all 0.2s;
      "></div>
      <span style="font-weight: 600; letter-spacing: 1px;">EXODUS</span><span style="color: #0f0; font-weight: 600;">XE</span>
      <span id="exodusxe-action" style="
        color: #666;
        font-size: 10px;
        margin-left: 8px;
        opacity: 0;
        transition: opacity 0.2s;
      "></span>
    </div>
  `;
  document.body.appendChild(indicator);
}

function updateIndicator(connected) {
  createIndicator();
  const dot = document.getElementById('exodusxe-dot');
  if (dot) {
    dot.style.background = connected ? '#0f0' : '#333';
    dot.style.boxShadow = connected ? '0 0 8px #0f0' : 'none';
  }
}

function flashIndicator(action) {
  const actionEl = document.getElementById('exodusxe-action');
  if (actionEl) {
    actionEl.textContent = action.toUpperCase();
    actionEl.style.opacity = '1';
    setTimeout(() => { actionEl.style.opacity = '0'; }, 500);
  }
}

function createCursorIndicator() {
  if (cursorIndicator) return;

  cursorIndicator = document.createElement('div');
  cursorIndicator.id = 'exodusxe-cursor';
  cursorIndicator.style.cssText = `
    position: fixed;
    width: 20px;
    height: 20px;
    background: rgba(0, 255, 0, 0.5);
    border: 2px solid #0f0;
    border-radius: 50%;
    pointer-events: none;
    z-index: 2147483647;
    transform: translate(-50%, -50%);
    display: none;
  `;
  document.body.appendChild(cursorIndicator);
}

function updateCursorIndicator(x, y) {
  createCursorIndicator();
  cursorIndicator.style.display = currentProfile === 'mouse' ? 'block' : 'none';
  cursorIndicator.style.left = x + 'px';
  cursorIndicator.style.top = y + 'px';
}

// WebSocket connection
function connect(wsUrl, roomId) {
  console.log('ExodusXE: connect() called with', wsUrl, roomId);

  // Force wss:// for HTTPS pages
  if (window.location.protocol === 'https:' && wsUrl.startsWith('ws://')) {
    wsUrl = wsUrl.replace('ws://', 'wss://');
    console.log('ExodusXE: Upgraded to secure WebSocket:', wsUrl);
  }

  // Store current room info globally
  currentWsUrl = wsUrl;
  currentRoomId = roomId;

  if (ws) {
    console.log('ExodusXE: Closing existing connection');
    intentionalClose = true;
    ws.close();
  }

  try {
    console.log('ExodusXE: Creating WebSocket to', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('ExodusXE: WebSocket connected! Joining room', roomId);
      ws.send(JSON.stringify({ type: 'join', roomId, role: 'display' }));
      isConnected = true;
      updateIndicator(true);

      // Auto-detect and broadcast site profile after short delay
      setTimeout(() => {
        broadcastDetectedProfile();
      }, 500);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log('ExodusXE content script received:', data);

        if (data.type === 'action') {
          console.log('ExodusXE: Processing action:', data.action);
          handleAction(data.action);
        }

        if (data.type === 'gesture') {
          console.log('ExodusXE: Processing gesture:', data.gesture);
          handleGesture(data.gesture, data.data);
        }

        if (data.type === 'motion') {
          handleMotion(data.x, data.y);
        }

        if (data.type === 'status') {
          updateIndicator(data.controllers > 0);
        }

        if (data.type === 'profileChanged') {
          console.log('ExodusXE: Profile changed to:', data.profile);
          // Map profile name to key (e.g., "Video Player" -> "video")
          const nameToKey = {
            'universal': 'universal',
            'presentations': 'presentation',
            'video player': 'video',
            'video calls': 'meeting',
            'scroll & read': 'scroll',
            'mouse mode': 'mouse'
          };
          const profileName = data.profile?.name?.toLowerCase() || 'universal';
          currentProfile = nameToKey[profileName] || 'universal';
          console.log('ExodusXE: currentProfile set to:', currentProfile);
        }
      } catch (err) {
        console.error('ExodusXE: Message parse error', err);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      updateIndicator(false);

      // Only auto-reconnect if not intentionally closed
      if (!intentionalClose && currentWsUrl && currentRoomId) {
        setTimeout(() => {
          connect(currentWsUrl, currentRoomId);
        }, 3000);
      }
      intentionalClose = false;
    };

    ws.onerror = () => {
      console.error('ExodusXE: WebSocket error');
    };

  } catch (e) {
    console.error('ExodusXE: Connection failed', e);
  }
}

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('ExodusXE: Content script received message from popup:', msg);

  if (msg.type === 'connect') {
    console.log('ExodusXE: Connecting to', msg.wsUrl, 'room', msg.roomId);
    currentProfile = msg.profile || 'universal';
    // Update storage so page refreshes use the new room
    chrome.storage.local.set({ roomId: msg.roomId, wsUrl: msg.wsUrl, profile: currentProfile });
    connect(msg.wsUrl, msg.roomId);
    sendResponse({ status: 'connecting' });
  }

  if (msg.type === 'setProfile') {
    console.log('ExodusXE: Setting profile to', msg.profile);
    currentProfile = msg.profile;
    cursorIndicator && (cursorIndicator.style.display = currentProfile === 'mouse' ? 'block' : 'none');
    sendResponse({ status: 'profile updated' });
  }

  return true;
});

// Check for existing session on load
chrome.storage.local.get(['roomId', 'wsUrl', 'profile'], (data) => {
  console.log('ExodusXE: Checking stored session:', data);
  if (data.roomId && data.wsUrl) {
    currentProfile = data.profile || 'universal';
    console.log('ExodusXE: Found stored session, connecting...');
    connect(data.wsUrl, data.roomId);
  } else {
    console.log('ExodusXE: No stored session found');
  }
});

// Listen to storage changes (handles room changes from popup)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.roomId && changes.wsUrl) {
    const newRoomId = changes.roomId.newValue;
    const newWsUrl = changes.wsUrl.newValue;
    console.log('ExodusXE: Storage changed, switching to room:', newRoomId);
    if (newRoomId && newWsUrl && newRoomId !== currentRoomId) {
      currentProfile = changes.profile?.newValue || currentProfile;
      connect(newWsUrl, newRoomId);
    }
  }
});

// Initialize indicator
createIndicator();
console.log('ExodusXE: Content script loaded on', window.location.href);
