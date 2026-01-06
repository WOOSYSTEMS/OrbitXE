// ExodusXE Extension Popup - Simplified
// Communicates with background service worker

async function init() {
  // Ask background for session info
  chrome.runtime.sendMessage({ type: 'getSession' }, (data) => {
    if (data?.roomId && data?.controllerUrl) {
      showConnected(data.roomId, data.controllerUrl, data.controllers);
    } else {
      // No session, create one
      chrome.runtime.sendMessage({ type: 'connect' });
      showLoading();
      // Poll for session
      setTimeout(init, 500);
    }
  });
}

function showLoading() {
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('main').style.display = 'none';
}

function showConnected(roomId, controllerUrl, controllers) {
  document.getElementById('qrCode').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(controllerUrl)}&bgcolor=0a0a0a&color=00ff88`;
  document.getElementById('roomCode').textContent = roomId;

  const connected = controllers > 0;
  document.getElementById('statusDot').classList.toggle('connected', connected);
  document.getElementById('statusText').textContent = connected ? 'Phone connected' : 'Scan to connect';

  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';
}

function newSession() {
  chrome.runtime.sendMessage({ type: 'newSession' });
  showLoading();
  setTimeout(init, 500);
}

// Listen for storage changes (connection status updates)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.controllers) {
    const connected = changes.controllers.newValue > 0;
    document.getElementById('statusDot').classList.toggle('connected', connected);
    document.getElementById('statusText').textContent = connected ? 'Phone connected' : 'Scan to connect';
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('newSessionBtn').addEventListener('click', newSession);
  init();

  // Auto-close popup after 5 seconds once connected
  setTimeout(() => {
    chrome.storage.local.get(['controllers'], (data) => {
      if (data.controllers > 0) {
        window.close();
      }
    });
  }, 5000);
});
