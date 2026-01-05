// ExodusXE Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.clear();
  console.log('ExodusXE extension installed');
});

// Keep track of active connections
let activeSession = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getSession') {
    chrome.storage.local.get(['roomId', 'wsUrl', 'profile'], sendResponse);
    return true;
  }
});
