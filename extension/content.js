// ExodusXE Content Script - Command Executor
// Receives commands from background, executes on page

// Virtual cursor position
let cursorX = window.innerWidth / 2;
let cursorY = window.innerHeight / 2;
let cursorVisible = false;
let cursorElement = null;

// Detect site type
function getSiteType() {
  const host = window.location.hostname;
  const path = window.location.pathname;

  if (host.includes('youtube.com')) return 'youtube';
  if (host.includes('netflix.com')) return 'netflix';
  if (host.includes('vimeo.com')) return 'vimeo';
  if (host.includes('twitch.tv')) return 'twitch';
  if (host.includes('spotify.com')) return 'spotify';
  if (host.includes('primevideo.com')) return 'primevideo';
  if (host.includes('disneyplus.com')) return 'disneyplus';
  if (host.includes('docs.google.com') && path.includes('/presentation')) return 'slides';
  if (host.includes('docs.google.com') && path.includes('/document')) return 'docs';
  if (host.includes('docs.google.com') && path.includes('/spreadsheets')) return 'sheets';
  if (host.includes('notion.so')) return 'notion';
  if (host.includes('figma.com')) return 'figma';
  if (host.includes('zoom.us')) return 'zoom';
  if (host.includes('meet.google.com')) return 'meet';
  if (host.includes('teams.microsoft.com')) return 'teams';

  return 'universal';
}

// Site-specific action handlers
const siteActions = {
  youtube: {
    play: () => { const v = document.querySelector('video'); if (v) v.paused ? v.play() : v.pause(); },
    seekForward: () => { const v = document.querySelector('video'); if (v) v.currentTime += 10; },
    seekBack: () => { const v = document.querySelector('video'); if (v) v.currentTime -= 10; },
    volumeUp: () => { const v = document.querySelector('video'); if (v) v.volume = Math.min(1, v.volume + 0.1); },
    volumeDown: () => { const v = document.querySelector('video'); if (v) v.volume = Math.max(0, v.volume - 0.1); },
    mute: () => { const v = document.querySelector('video'); if (v) v.muted = !v.muted; },
    fullscreen: () => { const b = document.querySelector('.ytp-fullscreen-button'); if (b) b.click(); },
    captions: () => { const b = document.querySelector('.ytp-subtitles-button'); if (b) b.click(); },
    next: () => { const b = document.querySelector('.ytp-next-button'); if (b) b.click(); },
    like: () => { const b = document.querySelector('like-button-view-model button, #top-level-buttons-computed ytd-toggle-button-renderer:first-child button'); if (b) b.click(); }
  },
  netflix: {
    play: () => { const v = document.querySelector('video'); if (v) v.paused ? v.play() : v.pause(); },
    seekForward: () => { const v = document.querySelector('video'); if (v) v.currentTime += 10; },
    seekBack: () => { const v = document.querySelector('video'); if (v) v.currentTime -= 10; },
    mute: () => { const v = document.querySelector('video'); if (v) v.muted = !v.muted; },
    fullscreen: () => document.fullscreenElement ? document.exitFullscreen() : document.body.requestFullscreen()
  },
  slides: {
    next: () => simulateKey('ArrowRight'),
    prev: () => simulateKey('ArrowLeft'),
    play: () => { const b = document.querySelector('[aria-label="Start slideshow"]'); if (b) b.click(); },
    exit: () => simulateKey('Escape')
  },
  zoom: {
    mute: () => simulateKey('a', { meta: true, shift: true }),
    video: () => simulateKey('v', { meta: true, shift: true }),
    chat: () => simulateKey('h', { meta: true, shift: true }),
    leave: () => simulateKey('w', { meta: true })
  },
  meet: {
    mute: () => simulateKey('d', { ctrl: true }),
    video: () => simulateKey('e', { ctrl: true }),
    chat: () => simulateKey('c', { ctrl: true, alt: true }),
    leave: () => { const b = document.querySelector('[aria-label*="Leave"]'); if (b) b.click(); }
  },
  universal: {}
};

// Simulate keyboard input
function simulateKey(key, modifiers = {}) {
  const keyMap = {
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 }
  };

  const mapping = keyMap[key] || { key, code: `Key${key.toUpperCase()}`, keyCode: key.charCodeAt(0) };
  const target = document.activeElement || document.body;

  const eventProps = {
    key: mapping.key,
    code: mapping.code,
    keyCode: mapping.keyCode,
    which: mapping.keyCode,
    bubbles: true,
    cancelable: true,
    view: window,
    metaKey: modifiers.meta || false,
    ctrlKey: modifiers.ctrl || false,
    altKey: modifiers.alt || false,
    shiftKey: modifiers.shift || false
  };

  target.dispatchEvent(new KeyboardEvent('keydown', eventProps));
  setTimeout(() => {
    target.dispatchEvent(new KeyboardEvent('keyup', eventProps));
  }, 50);
}

// Type text (for keyboard input)
function typeText(text) {
  const target = document.activeElement;
  if (!target) return;

  // Try input event for form fields
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    // Insert text at cursor position
    const start = target.selectionStart || 0;
    const end = target.selectionEnd || 0;
    const currentValue = target.value || target.textContent || '';

    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      target.value = currentValue.slice(0, start) + text + currentValue.slice(end);
      target.selectionStart = target.selectionEnd = start + text.length;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, text);
    }
  } else {
    // Simulate key presses for non-input elements
    for (const char of text) {
      simulateKey(char);
    }
  }
}

// Handle mouse movement
function handleMouse(x, y, action) {
  // Update cursor position (relative movement)
  cursorX = Math.max(0, Math.min(window.innerWidth, cursorX + x * 3));
  cursorY = Math.max(0, Math.min(window.innerHeight, cursorY + y * 3));

  updateCursor();

  if (action === 'click') {
    performClick(cursorX, cursorY, 'left');
  } else if (action === 'rightClick') {
    performClick(cursorX, cursorY, 'right');
  } else if (action === 'doubleClick') {
    performClick(cursorX, cursorY, 'left');
    setTimeout(() => performClick(cursorX, cursorY, 'left'), 100);
  }
}

// Perform click at position
function performClick(x, y, button) {
  const element = document.elementFromPoint(x, y);
  if (!element) return;

  // Flash cursor on click
  if (cursorElement) {
    cursorElement.style.transform = 'translate(-50%, -50%) scale(0.8)';
    setTimeout(() => {
      cursorElement.style.transform = 'translate(-50%, -50%) scale(1)';
    }, 100);
  }

  const eventProps = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: button === 'right' ? 2 : 0
  };

  element.dispatchEvent(new MouseEvent('mousedown', eventProps));
  element.dispatchEvent(new MouseEvent('mouseup', eventProps));
  element.dispatchEvent(new MouseEvent('click', eventProps));

  // Focus if clickable
  if (element.focus) element.focus();
}

// Handle scroll
function handleScroll(deltaX, deltaY) {
  console.log('ExodusXE: Scrolling', deltaX, deltaY);
  window.scrollBy({
    left: deltaX,
    top: deltaY,
    behavior: 'smooth'
  });
}

// Handle action (site-specific or universal)
function handleAction(action, value) {
  const siteType = getSiteType();
  const handlers = siteActions[siteType] || siteActions.universal;

  if (handlers[action]) {
    handlers[action](value);
    showFeedback(action);
    return;
  }

  // Universal fallback actions
  switch (action) {
    case 'up': simulateKey('ArrowUp'); break;
    case 'down': simulateKey('ArrowDown'); break;
    case 'left': simulateKey('ArrowLeft'); break;
    case 'right': simulateKey('ArrowRight'); break;
    case 'enter': simulateKey('Enter'); break;
    case 'escape': simulateKey('Escape'); break;
    case 'space': simulateKey('Space'); break;
    case 'tab': simulateKey('Tab'); break;
    case 'back': history.back(); break;
    case 'forward': history.forward(); break;
    case 'refresh': location.reload(); break;
    case 'scrollUp': handleScroll(0, -300); break;
    case 'scrollDown': handleScroll(0, 300); break;
    default:
      console.log('ExodusXE: Unknown action', action);
  }

  showFeedback(action);
}

// Create/update cursor element
function updateCursor() {
  if (!cursorElement) {
    cursorElement = document.createElement('div');
    cursorElement.id = 'exodusxe-cursor';
    cursorElement.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M4 4L12 20L14 14L20 12L4 4Z" fill="rgba(0,255,0,0.9)" stroke="#000" stroke-width="1.5"/>
      </svg>
    `;
    cursorElement.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: transform 0.1s ease-out;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
    `;
    document.body.appendChild(cursorElement);
  }

  cursorElement.style.left = cursorX + 'px';
  cursorElement.style.top = cursorY + 'px';
  cursorElement.style.display = cursorVisible ? 'block' : 'none';
}

// Show visual feedback
let feedbackElement = null;
function showFeedback(action) {
  if (!feedbackElement) {
    feedbackElement = document.createElement('div');
    feedbackElement.id = 'exodusxe-feedback';
    feedbackElement.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.8);
      color: #0f0;
      padding: 8px 20px;
      border-radius: 20px;
      font-family: -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 600;
      z-index: 2147483647;
      opacity: 0;
      transition: opacity 0.2s;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(0,255,0,0.3);
    `;
    document.body.appendChild(feedbackElement);
  }

  feedbackElement.textContent = action.toUpperCase();
  feedbackElement.style.opacity = '1';
  setTimeout(() => { feedbackElement.style.opacity = '0'; }, 800);
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'getSiteType':
      sendResponse({ siteType: getSiteType() });
      break;

    case 'action':
      handleAction(msg.action, msg.value);
      sendResponse({ status: 'ok' });
      break;

    case 'mouse':
      cursorVisible = true;
      handleMouse(msg.x, msg.y, msg.action);
      sendResponse({ status: 'ok' });
      break;

    case 'keyboard':
      console.log('ExodusXE: Keyboard message:', msg);
      if (msg.key === 'Backspace') {
        simulateKey('Backspace');
      } else if (msg.key === 'Space') {
        // Space can be typed as text or simulated as key
        const target = document.activeElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          typeText(' ');
        } else {
          simulateKey('Space');
        }
      } else if (msg.key === 'Enter') {
        simulateKey('Enter');
      } else if (msg.text) {
        typeText(msg.text);
      } else if (msg.key) {
        simulateKey(msg.key);
      }
      sendResponse({ status: 'ok' });
      break;

    case 'scroll':
      handleScroll(msg.deltaX || 0, msg.deltaY || 0);
      sendResponse({ status: 'ok' });
      break;

    case 'showCursor':
      cursorVisible = msg.visible;
      updateCursor();
      sendResponse({ status: 'ok' });
      break;
  }

  return true;
});

// Hide cursor when idle
let cursorTimeout;
document.addEventListener('mousemove', () => {
  clearTimeout(cursorTimeout);
  cursorTimeout = setTimeout(() => {
    cursorVisible = false;
    updateCursor();
  }, 5000);
});

console.log('ExodusXE: Content script loaded -', getSiteType());
