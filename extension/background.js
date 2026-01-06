// ExodusXE Background Service Worker - Central Hub
// Single WebSocket connection, controls active tab

let ws = null;
let roomId = null;
let serverUrl = 'https://exodusxe-production.up.railway.app';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

console.log('OrbitXE: Background script loaded');

// Connect to server
async function connectToServer() {
  console.log('OrbitXE: connectToServer called, ws state:', ws?.readyState);

  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('OrbitXE: Already connected');
    return;
  }

  try {
    // Create room if needed
    if (!roomId) {
      console.log('OrbitXE: Creating new room...');
      const res = await fetch(`${serverUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      roomId = data.roomId;
      console.log('OrbitXE: Room created:', roomId);

      // Store for popup
      await chrome.storage.local.set({
        roomId,
        serverUrl,
        controllerUrl: `${serverUrl}/remote/${roomId}`
      });
    }

    // Connect WebSocket
    const wsUrl = `${serverUrl.replace('https', 'wss')}/ws/${roomId}`;
    console.log('OrbitXE: Connecting to', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('OrbitXE: WebSocket connected!');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'join', roomId, role: 'display' }));

      // Send initial data
      setTimeout(() => {
        sendActiveTabInfo();
        sendTabList();
      }, 500);
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      console.log('OrbitXE: Received message:', msg.type, msg);

      switch (msg.type) {
        case 'action':
          console.log('OrbitXE: Sending action to tab:', msg.action);
          await sendToActiveTab({ type: 'action', action: msg.action, value: msg.value });
          break;

        case 'mouse':
          console.log('OrbitXE: Sending mouse to tab:', msg);
          await sendToActiveTab({ type: 'mouse', x: msg.x, y: msg.y, action: msg.action });
          break;

        case 'keyboard':
          console.log('OrbitXE: Sending keyboard to tab:', msg);
          await sendToActiveTab({ type: 'keyboard', key: msg.key, text: msg.text });
          break;

        case 'scroll':
          console.log('OrbitXE: Sending scroll to tab:', msg);
          await sendToActiveTab({ type: 'scroll', deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0 });
          break;

        case 'switchTab':
          console.log('OrbitXE: Switching to tab:', msg.tabId);
          try {
            await chrome.tabs.update(msg.tabId, { active: true });
            setTimeout(sendActiveTabInfo, 200);
          } catch (e) {
            console.error('OrbitXE: Failed to switch tab:', e);
          }
          break;

        case 'openTab':
          console.log('OrbitXE: Opening new tab:', msg.url);
          try {
            await chrome.tabs.create({ url: msg.url, active: true });
            setTimeout(() => {
              sendTabList();
              sendActiveTabInfo();
            }, 500);
          } catch (e) {
            console.error('OrbitXE: Failed to open tab:', e);
          }
          break;

        case 'getTabs':
          console.log('OrbitXE: Sending tab list');
          sendTabList();
          break;

        case 'status':
        case 'joined':
          console.log('OrbitXE: Status update, controllers:', msg.controllers);
          chrome.storage.local.set({ controllers: msg.controllers || 0 });
          break;

        case 'pong':
          // Keep-alive response
          break;
      }
    };

    ws.onclose = () => {
      console.log('OrbitXE: WebSocket disconnected');
      ws = null;

      // Reconnect with backoff
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(1000 * reconnectAttempts, 10000);
        console.log('OrbitXE: Reconnecting in', delay, 'ms');
        setTimeout(connectToServer, delay);
      }
    };

    ws.onerror = (e) => {
      console.error('OrbitXE: WebSocket error', e);
    };

  } catch (e) {
    console.error('OrbitXE: Connection failed', e);
    // Retry
    setTimeout(connectToServer, 3000);
  }
}

// Send message to active tab's content script
async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('OrbitXE: Active tab:', tab?.id, tab?.url);

    if (tab?.id && tab.url && !tab.url.startsWith('chrome://')) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, message);
        console.log('OrbitXE: Tab response:', response);
      } catch (e) {
        console.log('OrbitXE: Content script not ready, injecting...');
        // Try to inject content script
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          // Retry sending message
          setTimeout(async () => {
            try {
              await chrome.tabs.sendMessage(tab.id, message);
            } catch (e) {
              console.error('OrbitXE: Still failed after injection:', e);
            }
          }, 100);
        } catch (injectError) {
          console.error('OrbitXE: Could not inject:', injectError);
        }
      }
    }
  } catch (e) {
    console.error('OrbitXE: Failed to send to tab', e);
  }
}

// Send active tab info to phone
async function sendActiveTabInfo() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('OrbitXE: Cannot send tab info, ws not ready');
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      // Get site type from content script
      let siteType = 'universal';
      if (tab.url && !tab.url.startsWith('chrome://')) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'getSiteType' });
          siteType = response?.siteType || 'universal';
        } catch (e) {
          // Content script not loaded, determine from URL
          const url = tab.url || '';
          if (url.includes('youtube.com')) siteType = 'youtube';
          else if (url.includes('netflix.com')) siteType = 'netflix';
          else if (url.includes('docs.google.com/presentation')) siteType = 'slides';
          else if (url.includes('meet.google.com')) siteType = 'meet';
          else if (url.includes('zoom.us')) siteType = 'zoom';
        }
      }

      console.log('OrbitXE: Sending active tab info:', tab.title, siteType);
      ws.send(JSON.stringify({
        type: 'activeTab',
        tab: {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl
        },
        siteType
      }));
    }
  } catch (e) {
    console.error('OrbitXE: Failed to get active tab', e);
  }
}

// Send list of all tabs to phone
async function sendTabList() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tabList = tabs.map(t => ({
      id: t.id,
      title: t.title,
      url: t.url,
      favIconUrl: t.favIconUrl,
      active: t.active
    }));

    console.log('OrbitXE: Sending tab list, count:', tabList.length);
    ws.send(JSON.stringify({ type: 'tabList', tabs: tabList }));
  } catch (e) {
    console.error('OrbitXE: Failed to get tabs', e);
  }
}

// Listen for tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  console.log('OrbitXE: Tab activated:', activeInfo.tabId);

  // Proactively inject content script into newly activated tab
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeInfo.tabId },
          files: ['content.js']
        });
        console.log('OrbitXE: Content script injected into tab', activeInfo.tabId);
      } catch (e) {
        // Already injected or can't inject, that's fine
        console.log('OrbitXE: Script injection skipped:', e.message);
      }
    }
  } catch (e) {
    console.error('OrbitXE: Tab injection error:', e);
  }

  sendActiveTabInfo();
  sendTabList();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    console.log('OrbitXE: Tab updated:', tabId);
    sendActiveTabInfo();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  console.log('OrbitXE: New tab created:', tab.id);
  // Wait for tab to be ready
  setTimeout(() => {
    sendTabList();
    sendActiveTabInfo();
  }, 300);
});

chrome.tabs.onRemoved.addListener(() => {
  console.log('OrbitXE: Tab removed');
  sendTabList();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('OrbitXE: Message from popup:', msg.type);

  if (msg.type === 'getSession') {
    chrome.storage.local.get(['roomId', 'serverUrl', 'controllerUrl', 'controllers'], (data) => {
      console.log('OrbitXE: Returning session data:', data);
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === 'connect') {
    connectToServer();
    sendResponse({ status: 'connecting' });
    return true;
  }

  if (msg.type === 'newSession') {
    console.log('OrbitXE: Creating new session');
    roomId = null;
    if (ws) ws.close();
    chrome.storage.local.remove(['roomId', 'controllerUrl', 'controllers']);
    connectToServer();
    sendResponse({ status: 'creating' });
    return true;
  }

  if (msg.type === 'disconnect') {
    if (ws) ws.close();
    ws = null;
    sendResponse({ status: 'disconnected' });
    return true;
  }

  // Forward showKeyboard from content script to phone
  if (msg.type === 'showKeyboard') {
    console.log('OrbitXE: Forwarding showKeyboard to phone');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'showKeyboard' }));
    }
    sendResponse({ status: 'ok' });
    return true;
  }

  return true;
});

// Auto-connect on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('OrbitXE: Extension installed/updated');
  chrome.storage.local.clear();
  // Don't auto-connect, wait for popup
});

// Auto-connect on browser startup if we had a session
chrome.runtime.onStartup.addListener(() => {
  console.log('OrbitXE: Browser startup');
  chrome.storage.local.get(['roomId'], (data) => {
    if (data.roomId) {
      roomId = data.roomId;
      connectToServer();
    }
  });
});

// Keep service worker alive with regular pings and tab updates
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
    // Also send tab updates periodically
    sendTabList();
    sendActiveTabInfo();
  }
}, 15000);

// Also respond to alarms to keep alive
chrome.alarms?.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('OrbitXE: Keep-alive ping');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }
});
