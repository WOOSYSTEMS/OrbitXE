// ExodusXE Background Service Worker - Central Hub
// Single WebSocket connection, controls active tab

let ws = null;
let roomId = null;
let serverUrl = 'https://exodusxe-production.up.railway.app';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Connect to server
async function connectToServer() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    // Create room if needed
    if (!roomId) {
      const res = await fetch(`${serverUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      roomId = data.roomId;

      // Store for popup
      await chrome.storage.local.set({
        roomId,
        serverUrl,
        controllerUrl: `${serverUrl}/remote/${roomId}`
      });
    }

    // Connect WebSocket
    const wsUrl = `${serverUrl.replace('https', 'wss')}/ws/${roomId}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('ExodusXE: Connected to server');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'join', roomId, role: 'display' }));

      // Send current tab info
      sendActiveTabInfo();
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      console.log('ExodusXE: Received', msg.type);

      switch (msg.type) {
        case 'action':
          sendToActiveTab({ type: 'action', action: msg.action, value: msg.value });
          break;

        case 'mouse':
          sendToActiveTab({ type: 'mouse', x: msg.x, y: msg.y, action: msg.action });
          break;

        case 'keyboard':
          sendToActiveTab({ type: 'keyboard', key: msg.key, text: msg.text });
          break;

        case 'scroll':
          sendToActiveTab({ type: 'scroll', deltaX: msg.deltaX, deltaY: msg.deltaY });
          break;

        case 'switchTab':
          chrome.tabs.update(msg.tabId, { active: true });
          break;

        case 'getTabs':
          sendTabList();
          break;

        case 'status':
        case 'joined':
          chrome.storage.local.set({ controllers: msg.controllers });
          break;
      }
    };

    ws.onclose = () => {
      console.log('ExodusXE: Disconnected');
      ws = null;

      // Reconnect with backoff
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(connectToServer, Math.min(1000 * reconnectAttempts, 10000));
      }
    };

    ws.onerror = (e) => {
      console.error('ExodusXE: WebSocket error', e);
    };

  } catch (e) {
    console.error('ExodusXE: Connection failed', e);
  }
}

// Send message to active tab's content script
async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (e) {
    console.error('ExodusXE: Failed to send to tab', e);
  }
}

// Send active tab info to phone
async function sendActiveTabInfo() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      // Get site type from content script
      let siteType = 'universal';
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'getSiteType' });
        siteType = response?.siteType || 'universal';
      } catch (e) {}

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
    console.error('ExodusXE: Failed to get active tab', e);
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

    ws.send(JSON.stringify({ type: 'tabList', tabs: tabList }));
  } catch (e) {
    console.error('ExodusXE: Failed to get tabs', e);
  }
}

// Listen for tab changes
chrome.tabs.onActivated.addListener(() => {
  sendActiveTabInfo();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    sendActiveTabInfo();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getSession') {
    chrome.storage.local.get(['roomId', 'serverUrl', 'controllerUrl', 'controllers'], sendResponse);
    return true;
  }

  if (msg.type === 'connect') {
    connectToServer();
    sendResponse({ status: 'connecting' });
  }

  if (msg.type === 'newSession') {
    roomId = null;
    if (ws) ws.close();
    chrome.storage.local.remove(['roomId', 'controllerUrl']);
    connectToServer();
    sendResponse({ status: 'creating' });
    return true;
  }

  if (msg.type === 'disconnect') {
    if (ws) ws.close();
    ws = null;
    sendResponse({ status: 'disconnected' });
  }
});

// Auto-connect on install/startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.clear();
  console.log('ExodusXE installed');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['roomId'], (data) => {
    if (data.roomId) {
      roomId = data.roomId;
      connectToServer();
    }
  });
});

// Keep service worker alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);
