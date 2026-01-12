const { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, screen, desktopCapturer, globalShortcut } = require('electron');
const { exec, execSync } = require('child_process');
const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Platform detection
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const platformName = isMac ? 'mac' : isWindows ? 'windows' : 'linux';

// Helper to get resource path (works both in dev and packaged)
function getResourcePath(filename) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, filename);
  }
  return path.join(__dirname, filename);
}

// Cliclick path (bundled with app for distribution)
function getCliclickPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'cliclick');
  }
  // Development: use local copy or homebrew
  const localCliclick = path.join(__dirname, 'cliclick');
  if (fs.existsSync(localCliclick)) {
    return localCliclick;
  }
  return '${getCliclickPath()}';
}

// Use nut-js for native cursor control (smooth, no process spawning)
let nutMouse = null;
let nutKeyboard = null;
try {
  const { mouse, keyboard, Point } = require('@nut-tree-fork/nut-js');
  mouse.config.autoDelayMs = 0;
  mouse.config.mouseSpeed = 10000; // instant
  nutMouse = mouse;
  nutKeyboard = keyboard;
  console.log('Using nut-js for native mouse control');
} catch (e) {
  console.log('nut-js not available, falling back to cliclick');
}

// Legacy robotjs (keeping for reference)
let robot = null;

// SSL certificates for HTTPS (enables gyroscope on iOS)
const sslOptions = {
  key: fs.readFileSync(getResourcePath('key.pem')),
  cert: fs.readFileSync(getResourcePath('cert.pem'))
};
const QRCode = require('qrcode');
const crypto = require('crypto');

const PORT = 8765;
const CLOUD_API = 'https://orbitxe.com';

// Generate unique session token for this instance
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

// License management
const LICENSE_PATH = path.join(app.getPath('userData'), 'license.json');
let currentLicense = {
  tier: 'free', // 'free', 'trial', 'pro', 'lifetime'
  email: null,
  expiresAt: null,
  token: null
};

function loadLicense() {
  try {
    if (fs.existsSync(LICENSE_PATH)) {
      const data = JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
      currentLicense = data;
      // Check if trial/subscription expired
      if (currentLicense.expiresAt && new Date(currentLicense.expiresAt) < new Date()) {
        if (currentLicense.tier === 'trial') {
          currentLicense.tier = 'free';
          saveLicense();
        }
      }
    }
  } catch (e) {
    console.error('Failed to load license:', e.message);
  }
}

function saveLicense() {
  try {
    fs.writeFileSync(LICENSE_PATH, JSON.stringify(currentLicense, null, 2));
  } catch (e) {
    console.error('Failed to save license:', e.message);
  }
}

// Validate license with cloud server
async function validateLicense(token) {
  try {
    const res = await fetch(`${CLOUD_API}/api/auth/validate`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('License validation error:', e.message);
    return null;
  }
}

// Check if feature is available
function hasFeature(feature) {
  const proFeatures = ['media', 'monitors', 'files', 'customShortcuts'];
  if (!proFeatures.includes(feature)) return true;
  return ['trial', 'pro', 'lifetime'].includes(currentLicense.tier);
}

// Load license on startup
loadLicense();

let mainWindow = null;
let laserWindow = null;
let tray = null;
let connectedDevices = new Map();
let sessionHistory = [];
let customShortcuts = {};
let quickActions = [];

// Get local IP (prefer en0/WiFi and common local network ranges)
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let fallback = null;

  const priorityOrder = ['en0', 'en1', 'eth0', 'wlan0'];

  for (const name of priorityOrder) {
    if (interfaces[name]) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.')) {
            return iface.address;
          }
        }
      }
    }
  }

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.')) {
          return iface.address;
        }
        if (!fallback) fallback = iface.address;
      }
    }
  }

  return fallback || '127.0.0.1';
}

const localIP = getLocalIP();
const localRemoteUrl = `http://${localIP}:${PORT}/remote?s=${SESSION_TOKEN}`;
const secureRemoteUrl = `https://${localIP}:${PORT + 1}/remote?s=${SESSION_TOKEN}`;

// Key code mapping for macOS
const keyCodeMap = {
  'up': 126, 'down': 125, 'left': 123, 'right': 124,
  'enter': 36, 'return': 36, 'space': 49, 'escape': 53,
  'tab': 48, 'backspace': 51, 'delete': 117,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'volumeup': 72, 'volumedown': 73, 'mute': 74,
  'playpause': 49, 'nexttrack': 124, 'prevtrack': 123,
  'grave': 50, '`': 50
};

// Media key handling - use NX key codes for actual media keys
const mediaKeys = {
  'playpause': 'playpause',
  'next': 'next',
  'prev': 'prev',
  'volumeup': 'volumeup',
  'volumedown': 'volumedown',
  'mute': 'mute'
};

// Execute media control - cross-platform
function executeMediaKey(action) {
  if (isMac) {
    switch (action) {
      case 'playpause':
        exec(`osascript -e 'tell application "Spotify" to playpause'`, (err) => {
          if (err) exec(`osascript -e 'tell application "Music" to playpause'`, (err2) => {
            if (err2) exec(`osascript -e 'tell application "System Events" to keystroke space'`);
          });
        });
        break;
      case 'next':
        exec(`osascript -e 'tell application "Spotify" to next track'`, (err) => {
          if (err) exec(`osascript -e 'tell application "Music" to next track'`, (err2) => {
            if (err2) exec(`osascript -e 'tell application "System Events" to keystroke "n" using {shift down}'`);
          });
        });
        break;
      case 'prev':
        exec(`osascript -e 'tell application "Spotify" to previous track'`, (err) => {
          if (err) exec(`osascript -e 'tell application "Music" to previous track'`, (err2) => {
            if (err2) exec(`osascript -e 'tell application "System Events" to keystroke "p" using {shift down}'`);
          });
        });
        break;
      case 'volumeup':
        exec(`osascript -e 'set volume output volume ((output volume of (get volume settings)) + 5)'`);
        break;
      case 'volumedown':
        exec(`osascript -e 'set volume output volume ((output volume of (get volume settings)) - 5)'`);
        break;
      case 'mute':
        exec(`osascript -e 'set volume output muted not (output muted of (get volume settings))'`);
        break;
    }
  } else if (isWindows) {
    // Windows media controls using PowerShell and nircmd
    switch (action) {
      case 'playpause':
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"');
        break;
      case 'next':
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]176)"');
        break;
      case 'prev':
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]177)"');
        break;
      case 'volumeup':
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
        break;
      case 'volumedown':
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
        break;
      case 'mute':
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"');
        break;
    }
  }
}

// App-specific shortcuts - platform aware
const appShortcutsMac = {
  youtube: {
    playpause: 'k', fullscreen: 'f', mute: 'm',
    next: 'shift+n', prev: 'shift+p', captions: 'c',
    forward10: 'l', back10: 'j', speed_up: 'shift+.', speed_down: 'shift+,'
  },
  netflix: {
    playpause: 'space', fullscreen: 'f', mute: 'm',
    forward10: 'right', back10: 'left', next: 'shift+n'
  },
  powerpoint: {
    next: 'right', prev: 'left', start: 'shift+cmd+return',
    end: 'escape', pointer: 'cmd+p', blank: 'b'
  },
  zoom: {
    mute: 'cmd+shift+a', video: 'cmd+shift+v', share: 'cmd+shift+s',
    chat: 'cmd+shift+h', participants: 'cmd+u', leave: 'cmd+w'
  },
  spotify: {
    playpause: 'space', next: 'cmd+right', prev: 'cmd+left',
    volumeup: 'cmd+up', volumedown: 'cmd+down', shuffle: 'cmd+s', repeat: 'cmd+r'
  },
  vscode: {
    save: 'cmd+s', find: 'cmd+f', replace: 'cmd+alt+f',
    terminal: 'ctrl+`', sidebar: 'cmd+b', palette: 'cmd+shift+p',
    split: 'cmd+\\', close: 'cmd+w'
  }
};

const appShortcutsWindows = {
  youtube: {
    playpause: 'k', fullscreen: 'f', mute: 'm',
    next: 'shift+n', prev: 'shift+p', captions: 'c',
    forward10: 'l', back10: 'j', speed_up: 'shift+.', speed_down: 'shift+,'
  },
  netflix: {
    playpause: 'space', fullscreen: 'f', mute: 'm',
    forward10: 'right', back10: 'left', next: 'shift+n'
  },
  powerpoint: {
    next: 'right', prev: 'left', start: 'f5',
    end: 'escape', pointer: 'ctrl+p', blank: 'b'
  },
  zoom: {
    mute: 'alt+a', video: 'alt+v', share: 'alt+s',
    chat: 'alt+h', participants: 'alt+u', leave: 'alt+q'
  },
  spotify: {
    playpause: 'space', next: 'ctrl+right', prev: 'ctrl+left',
    volumeup: 'ctrl+up', volumedown: 'ctrl+down', shuffle: 'ctrl+s', repeat: 'ctrl+r'
  },
  vscode: {
    save: 'ctrl+s', find: 'ctrl+f', replace: 'ctrl+h',
    terminal: 'ctrl+`', sidebar: 'ctrl+b', palette: 'ctrl+shift+p',
    split: 'ctrl+\\', close: 'ctrl+w'
  }
};

const appShortcuts = isMac ? appShortcutsMac : appShortcutsWindows;

// Robotjs key mapping
const robotKeyMap = {
  'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right',
  'enter': 'enter', 'return': 'enter', 'space': 'space', 'escape': 'escape',
  'tab': 'tab', 'backspace': 'backspace', 'delete': 'delete',
  'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4', 'f5': 'f5', 'f6': 'f6',
  'f7': 'f7', 'f8': 'f8', 'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12',
  'home': 'home', 'end': 'end', 'pageup': 'pageup', 'pagedown': 'pagedown'
};

// Simulate key press using nut-js (cross-platform)
function simulateKey(key) {
  if (nutKeyboard) {
    const { Key } = require('@nut-tree-fork/nut-js');
    const nutKeyMap = {
      'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
      'enter': Key.Enter, 'return': Key.Enter, 'space': Key.Space, 'escape': Key.Escape,
      'tab': Key.Tab, 'backspace': Key.Backspace, 'delete': Key.Delete,
      'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4, 'f5': Key.F5, 'f6': Key.F6,
      'f7': Key.F7, 'f8': Key.F8, 'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
      'home': Key.Home, 'end': Key.End, 'pageup': Key.PageUp, 'pagedown': Key.PageDown
    };
    const nutKey = nutKeyMap[key?.toLowerCase()];
    if (nutKey) {
      nutKeyboard.pressKey(nutKey).then(() => nutKeyboard.releaseKey(nutKey)).catch(e => {
        console.error('nut-js key error:', e.message);
      });
    }
  } else if (isMac) {
    const keyCode = keyCodeMap[key?.toLowerCase()];
    if (keyCode !== undefined) {
      exec(`osascript -e 'tell application "System Events" to key code ${keyCode}'`, (err) => {
        if (err) console.error('Key error:', err.message);
      });
    }
  }
}

// Simulate keystroke (text character or key with modifiers) using nut-js
function simulateKeystroke(char, modifiers = []) {
  if (nutKeyboard) {
    const { Key } = require('@nut-tree-fork/nut-js');
    const nutKeyMap = {
      'up': Key.Up, 'down': Key.Down, 'left': Key.Left, 'right': Key.Right,
      'enter': Key.Enter, 'return': Key.Enter, 'space': Key.Space, 'escape': Key.Escape,
      'tab': Key.Tab, 'backspace': Key.Backspace, 'delete': Key.Delete,
      'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4, 'f5': Key.F5, 'f6': Key.F6,
      'f7': Key.F7, 'f8': Key.F8, 'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
      'home': Key.Home, 'end': Key.End, 'pageup': Key.PageUp, 'pagedown': Key.PageDown,
      'a': Key.A, 'b': Key.B, 'c': Key.C, 'd': Key.D, 'e': Key.E, 'f': Key.F, 'g': Key.G,
      'h': Key.H, 'i': Key.I, 'j': Key.J, 'k': Key.K, 'l': Key.L, 'm': Key.M, 'n': Key.N,
      'o': Key.O, 'p': Key.P, 'q': Key.Q, 'r': Key.R, 's': Key.S, 't': Key.T, 'u': Key.U,
      'v': Key.V, 'w': Key.W, 'x': Key.X, 'y': Key.Y, 'z': Key.Z,
      '=': Key.Equal, '-': Key.Minus, '[': Key.LeftBracket, ']': Key.RightBracket,
      '\\': Key.Backslash, ';': Key.Semicolon, "'": Key.Quote, ',': Key.Comma,
      '.': Key.Period, '/': Key.Slash, '`': Key.Grave
    };

    const nutModMap = {
      'command': isMac ? Key.LeftSuper : Key.LeftControl,
      'control': Key.LeftControl,
      'option': Key.LeftAlt,
      'shift': Key.LeftShift
    };

    const nutKey = nutKeyMap[char?.toLowerCase()];
    const nutMods = modifiers.map(m => nutModMap[m]).filter(Boolean);

    (async () => {
      try {
        // Press modifiers
        for (const mod of nutMods) await nutKeyboard.pressKey(mod);
        // Press and release key
        if (nutKey) {
          await nutKeyboard.pressKey(nutKey);
          await nutKeyboard.releaseKey(nutKey);
        }
        // Release modifiers
        for (const mod of nutMods.reverse()) await nutKeyboard.releaseKey(mod);
      } catch (e) {
        console.error('nut-js keystroke error:', e.message);
      }
    })();
  } else if (isMac) {
    let modStr = '';
    if (modifiers.length > 0) {
      modStr = ` using {${modifiers.map(m => m + ' down').join(', ')}}`;
    }

    const keyCode = keyCodeMap[char?.toLowerCase()];
    if (keyCode !== undefined) {
      exec(`osascript -e 'tell application "System Events" to key code ${keyCode}${modStr}'`, (err) => {
        if (err) console.error('Key code error:', err.message);
      });
    } else {
      const escaped = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      exec(`osascript -e 'tell application "System Events" to keystroke "${escaped}"${modStr}'`, (err) => {
        if (err) console.error('Keystroke error:', err.message);
      });
    }
  }
}

// Parse shortcut string like "cmd+shift+s"
function parseShortcut(shortcut) {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts.pop();
  const modifiers = parts.map(m => {
    if (m === 'cmd' || m === 'command') return 'command';
    if (m === 'ctrl' || m === 'control') return 'control';
    if (m === 'alt' || m === 'option') return 'option';
    if (m === 'shift') return 'shift';
    return m;
  });
  return { key, modifiers };
}

// Execute shortcut
function executeShortcut(shortcut) {
  const { key, modifiers } = parseShortcut(shortcut);
  simulateKeystroke(key, modifiers);
}

// Simulate mouse using cliclick
// Accumulate movements and batch them to reduce process spawning
let pendingMoveX = 0;
let pendingMoveY = 0;
let moveTimer = null;

function flushMouseMove() {
  if (pendingMoveX !== 0 || pendingMoveY !== 0) {
    const dx = Math.round(pendingMoveX * 2);
    const dy = Math.round(pendingMoveY * 2);
    const xSign = dx >= 0 ? '+' : '';
    const ySign = dy >= 0 ? '+' : '';
    try {
      execSync(`${getCliclickPath()} m:${xSign}${dx},${ySign}${dy}`, { timeout: 100 });
    } catch (e) {}
    pendingMoveX = 0;
    pendingMoveY = 0;
  }
  moveTimer = null;
}

function queueMouseMove(x, y) {
  pendingMoveX += x;
  pendingMoveY += y;
  if (!moveTimer) {
    moveTimer = setTimeout(flushMouseMove, 16); // 60fps
  }
}

function simulateMouse(x, y, action) {
  if (nutMouse) {
    // Use nut-js (native, smooth, no process spawning)
    (async () => {
      try {
        const pos = await nutMouse.getPosition();
        const dx = Math.round(x * 2);
        const dy = Math.round(y * 2);

        if (action === 'move' || !action) {
          await nutMouse.setPosition({ x: pos.x + dx, y: pos.y + dy });
        } else if (action === 'click') {
          await nutMouse.leftClick();
        } else if (action === 'rightclick') {
          await nutMouse.rightClick();
        } else if (action === 'doubleclick') {
          await nutMouse.doubleClick(0); // 0 = left button
        } else if (action === 'dragstart') {
          await nutMouse.pressButton(0);
        } else if (action === 'dragend') {
          await nutMouse.releaseButton(0);
        }
      } catch (e) {
        console.error('nut-js mouse error:', e.message);
      }
    })();
    return;
  } else if (robot) {
    // Legacy robotjs fallback
    try {
      const pos = robot.getMousePos();
      if (action === 'move' || !action) {
        const dx = Math.round(x * 2);
        const dy = Math.round(y * 2);
        robot.moveMouse(pos.x + dx, pos.y + dy);
      } else if (action === 'click') {
        robot.mouseClick();
      } else if (action === 'rightclick') {
        robot.mouseClick('right');
      } else if (action === 'doubleclick') {
        robot.mouseClick('left', true);
      } else if (action === 'drag') {
        const dx = Math.round(x * 2);
        const dy = Math.round(y * 2);
        robot.dragMouse(pos.x + dx, pos.y + dy);
      } else if (action === 'dragstart') {
        robot.mouseToggle('down');
      } else if (action === 'dragend') {
        robot.mouseToggle('up');
      }
    } catch (e) {
      console.error('robotjs mouse error:', e.message);
    }
  } else {
    // Fallback to cliclick (direct distribution)
    const logErr = (err) => { if (err) console.error('Mouse error:', err.message); };
    if (action === 'move' || !action) {
      queueMouseMove(x, y);
      return;
    } else if (action === 'click') {
      exec(`${getCliclickPath()} c:.`, logErr);
    } else if (action === 'rightclick') {
      exec(`${getCliclickPath()} rc:.`, logErr);
    } else if (action === 'doubleclick') {
      exec(`${getCliclickPath()} dc:.`, logErr);
    } else if (action === 'dragstart') {
      exec(`${getCliclickPath()} dd:.`, logErr);
    } else if (action === 'dragend') {
      exec(`${getCliclickPath()} du:.`, logErr);
    }
  }
}

// Scroll using robotjs or AppleScript
function simulateScroll(deltaX, deltaY, natural = true) {
  const scrollY = natural ? -deltaY : deltaY;
  const scrollX = natural ? -deltaX : deltaX;

  if (nutMouse) {
    // Use nut-js for scrolling (cross-platform)
    (async () => {
      try {
        const amount = Math.round(scrollY / 30);
        if (amount !== 0) {
          await nutMouse.scrollDown(amount > 0 ? amount : 0);
          await nutMouse.scrollUp(amount < 0 ? -amount : 0);
        }
      } catch (e) {
        console.error('nut-js scroll error:', e.message);
      }
    })();
  } else if (isMac) {
    // Fallback to AppleScript for Mac
    if (Math.abs(scrollY) > Math.abs(scrollX)) {
      const amount = Math.round(scrollY / 10);
      exec(`osascript -e 'tell application "System Events" to scroll (${amount})'`, (err) => {
        if (err) {
          const keyCode = scrollY > 0 ? 125 : 126;
          const times = Math.min(Math.abs(Math.round(scrollY / 30)), 5);
          for (let i = 0; i < times; i++) {
            exec(`osascript -e 'tell application "System Events" to key code ${keyCode}'`);
          }
        }
      });
    }
  } else if (isWindows) {
    // Windows scroll using PowerShell
    const amount = Math.round(scrollY / 30);
    if (amount !== 0) {
      const direction = amount > 0 ? '{PGDN}' : '{PGUP}';
      const times = Math.min(Math.abs(amount), 5);
      for (let i = 0; i < times; i++) {
        exec(`powershell -command "(New-Object -ComObject WScript.Shell).SendKeys('${direction}')"`);
      }
    }
  }
}

// Zoom (pinch) - Cmd + scroll or Cmd +/-
function simulateZoom(scale) {
  if (scale > 1) {
    executeShortcut('cmd+=');
  } else if (scale < 1) {
    executeShortcut('cmd+-');
  }
}

// Three-finger swipe - Mission Control / App switching - cross-platform
function simulateSwipe(direction) {
  if (isMac) {
    switch (direction) {
      case 'up':
        // Mission Control
        exec(`osascript -e 'tell application "Mission Control" to launch'`);
        break;
      case 'down':
        // App Expose
        exec(`osascript -e 'tell application "System Events" to key code 125 using {control down}'`);
        break;
      case 'left':
        // Switch desktop left
        exec(`osascript -e 'tell application "System Events" to key code 123 using {control down}'`);
        break;
      case 'right':
        // Switch desktop right
        exec(`osascript -e 'tell application "System Events" to key code 124 using {control down}'`);
        break;
    }
  } else if (isWindows) {
    switch (direction) {
      case 'up':
        // Task View (Win + Tab)
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'^{ESCAPE}\')"');
        break;
      case 'down':
        // Show Desktop (Win + D)
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'^d\')"');
        break;
      case 'left':
        // Switch desktop left (Win + Ctrl + Left)
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'^%{LEFT}\')"');
        break;
      case 'right':
        // Switch desktop right (Win + Ctrl + Right)
        exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys(\'^%{RIGHT}\')"');
        break;
    }
  }
}

// Get active window/app info - cross-platform
function getActiveApp(callback) {
  if (isMac) {
    exec(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`, (err, stdout) => {
      const appName = err ? 'Unknown' : stdout.trim();

      // If it's a browser, check the URL for media sites
      if (appName === 'Safari') {
        exec(`osascript -e 'tell application "Safari" to get URL of current tab of front window'`, (err2, url) => {
          callback(detectMediaSite(appName, url?.trim()));
        });
      } else if (appName === 'Google Chrome') {
        exec(`osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`, (err2, url) => {
          callback(detectMediaSite(appName, url?.trim()));
        });
      } else if (appName === 'Firefox') {
        callback(appName);
      } else if (appName === 'Keynote') {
        exec(`osascript -e 'tell application "Keynote" to return playing of front document'`, (err2, playing) => {
          callback(playing?.trim() === 'true' ? 'Keynote Presenting' : 'Keynote');
        });
      } else if (appName === 'Microsoft PowerPoint') {
        exec(`osascript -e 'tell application "Microsoft PowerPoint"
          try
            if (count of slide show windows) > 0 then
              return "true"
            else
              return "false"
            end if
          on error
            return "false"
          end try
        end tell'`, (err2, running) => {
          callback(running?.trim() === 'true' ? 'PowerPoint Presenting' : 'Microsoft PowerPoint');
        });
      } else if (appName === 'Preview') {
        exec(`osascript -e 'tell application "System Events" to get name of front window of process "Preview"'`, (err2, winName) => {
          const isSlideshow = winName?.toLowerCase().includes('slideshow');
          callback(isSlideshow ? 'Preview Slideshow' : 'Preview');
        });
      } else {
        callback(appName);
      }
    });
  } else if (isWindows) {
    // Windows: Get foreground window title using PowerShell
    exec('powershell -command "(Get-Process | Where-Object {$_.MainWindowHandle -eq (Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();\' -Name Win32 -Namespace Native -PassThru)::GetForegroundWindow()}).ProcessName"', (err, stdout) => {
      let appName = err ? 'Unknown' : stdout.trim();

      // Map common Windows process names to friendly names
      const processNameMap = {
        'chrome': 'Google Chrome',
        'firefox': 'Firefox',
        'msedge': 'Microsoft Edge',
        'POWERPNT': 'Microsoft PowerPoint',
        'WINWORD': 'Microsoft Word',
        'EXCEL': 'Microsoft Excel',
        'Spotify': 'Spotify',
        'Code': 'VS Code',
        'explorer': 'File Explorer',
        'Discord': 'Discord',
        'Slack': 'Slack',
        'Zoom': 'Zoom'
      };

      appName = processNameMap[appName] || appName;

      // Check if browser for media site detection
      if (['Google Chrome', 'Firefox', 'Microsoft Edge'].includes(appName)) {
        // Get window title which often contains the page title
        exec('powershell -command "(Get-Process | Where-Object {$_.MainWindowHandle -eq (Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();\' -Name Win32 -Namespace Native -PassThru)::GetForegroundWindow()}).MainWindowTitle"', (err2, title) => {
          const windowTitle = title?.trim().toLowerCase() || '';
          if (windowTitle.includes('youtube')) callback('YouTube');
          else if (windowTitle.includes('netflix')) callback('Netflix');
          else if (windowTitle.includes('spotify')) callback('Spotify Web');
          else if (windowTitle.includes('prime video')) callback('Prime Video');
          else if (windowTitle.includes('disney+')) callback('Disney+');
          else if (windowTitle.includes('twitch')) callback('Twitch');
          else callback(appName);
        });
      } else {
        callback(appName);
      }
    });
  } else {
    callback('Unknown');
  }
}

// Detect media sites from browser URL
function detectMediaSite(browser, url) {
  if (!url) return browser;
  const urlLower = url.toLowerCase();

  if (urlLower.includes('youtube.com')) return 'YouTube';
  if (urlLower.includes('netflix.com')) return 'Netflix';
  if (urlLower.includes('primevideo') || urlLower.includes('amazon.com/gp/video')) return 'Prime Video';
  if (urlLower.includes('disneyplus.com')) return 'Disney+';
  if (urlLower.includes('hulu.com')) return 'Hulu';
  if (urlLower.includes('twitch.tv')) return 'Twitch';
  if (urlLower.includes('vimeo.com')) return 'Vimeo';
  if (urlLower.includes('open.spotify.com')) return 'Spotify Web';
  if (urlLower.includes('music.apple.com')) return 'Apple Music Web';
  if (urlLower.includes('soundcloud.com')) return 'SoundCloud';
  if (urlLower.includes('docs.google.com/presentation')) return 'Google Slides';
  if (urlLower.includes('figma.com')) return 'Figma';
  if (urlLower.includes('github.com')) return 'GitHub';

  return browser;
}

// Take screenshot - cross-platform
function takeScreenshot(callback) {
  const screenshotPath = path.join(os.tmpdir(), `orbitxe_screenshot_${Date.now()}.png`);

  if (isMac) {
    exec(`screencapture -x ${screenshotPath}`, (err) => {
      if (err) {
        callback(null, err);
      } else {
        const data = fs.readFileSync(screenshotPath);
        const base64 = data.toString('base64');
        fs.unlinkSync(screenshotPath);
        callback(`data:image/png;base64,${base64}`, null);
      }
    });
  } else if (isWindows) {
    // Use PowerShell to capture screenshot
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object {
        $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size)
        $bitmap.Save('${screenshotPath.replace(/\\/g, '\\\\')}')
      }
    `;
    exec(`powershell -command "${psScript.replace(/\n/g, ' ')}"`, (err) => {
      if (err) {
        callback(null, err);
      } else {
        try {
          const data = fs.readFileSync(screenshotPath);
          const base64 = data.toString('base64');
          fs.unlinkSync(screenshotPath);
          callback(`data:image/png;base64,${base64}`, null);
        } catch (e) {
          callback(null, e);
        }
      }
    });
  } else {
    callback(null, new Error('Screenshot not supported on this platform'));
  }
}

// Get screen preview using Electron's desktopCapturer (cross-platform)
async function getScreenPreview(callback) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 480, height: 270 }
    });

    if (sources.length > 0) {
      const thumbnail = sources[0].thumbnail;
      const dataUrl = thumbnail.toDataURL();
      callback(dataUrl, null);
    } else {
      callback(null, new Error('No screen source found'));
    }
  } catch (e) {
    console.error('Screen preview error:', e.message);
    callback(null, e);
  }
}

// Get monitors
function getMonitors() {
  const displays = screen.getAllDisplays();
  return displays.map((d, i) => ({
    id: d.id,
    name: `Display ${i + 1}`,
    width: d.bounds.width,
    height: d.bounds.height,
    x: d.bounds.x,
    y: d.bounds.y,
    primary: d.bounds.x === 0 && d.bounds.y === 0
  }));
}

// Move mouse to monitor
function switchMonitor(monitorId) {
  const displays = screen.getAllDisplays();
  const target = displays.find(d => d.id === monitorId);
  if (target) {
    const x = target.bounds.x + target.bounds.width / 2;
    const y = target.bounds.y + target.bounds.height / 2;
    if (robot) {
      robot.moveMouse(x, y);
    } else {
      exec(`${getCliclickPath()} m:${x},${y}`);
    }
  }
}

// Clipboard operations
function getClipboard() {
  return clipboard.readText();
}

function setClipboard(text) {
  clipboard.writeText(text);
}

// Wake on LAN
function wakeOnLan(macAddress, broadcastAddress = '255.255.255.255') {
  // Create magic packet
  const mac = macAddress.replace(/[:-]/g, '');
  const macBuffer = Buffer.from(mac, 'hex');
  const magicPacket = Buffer.alloc(102);

  // 6 bytes of 0xFF
  for (let i = 0; i < 6; i++) {
    magicPacket[i] = 0xff;
  }

  // MAC address repeated 16 times
  for (let i = 0; i < 16; i++) {
    macBuffer.copy(magicPacket, 6 + i * 6);
  }

  // Send UDP packet
  const dgram = require('dgram');
  const client = dgram.createSocket('udp4');
  client.bind(() => {
    client.setBroadcast(true);
    client.send(magicPacket, 9, broadcastAddress, (err) => {
      client.close();
    });
  });
}

// Log session
function logSession(deviceId, action) {
  sessionHistory.push({
    deviceId,
    action,
    timestamp: new Date().toISOString()
  });
  // Keep last 100 entries
  if (sessionHistory.length > 100) {
    sessionHistory = sessionHistory.slice(-100);
  }
}

// Handle commands
function handleCommand(msg, deviceId = 'unknown') {
  console.log('Command:', msg.type);
  logSession(deviceId, msg.type);

  switch (msg.type) {
    case 'key':
    case 'dpad':
    case 'action':
      simulateKey(msg.key || msg.direction || msg.action);
      break;

    case 'text':
      if (msg.text) {
        if (nutKeyboard) {
          // Use nut-js for cross-platform text input
          nutKeyboard.type(msg.text).catch(e => {
            console.error('nut-js text error:', e.message);
          });
        } else if (isMac) {
          const escaped = msg.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          exec(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
        }
      }
      break;

    case 'mouse':
      simulateMouse(msg.x || 0, msg.y || 0, msg.action);
      break;

    case 'scroll':
      simulateScroll(msg.deltaX || 0, msg.deltaY || 0, msg.natural !== false);
      break;

    case 'zoom':
      simulateZoom(msg.scale || 1);
      break;

    case 'swipe':
      simulateSwipe(msg.direction);
      break;

    case 'media':
      if (msg.action) {
        executeMediaKey(msg.action);
      }
      break;

    case 'volume':
      if (isMac) {
        if (msg.value !== undefined) {
          exec(`osascript -e 'set volume output volume ${msg.value}'`);
        } else if (msg.action === 'up') {
          exec(`osascript -e 'set volume output volume ((output volume of (get volume settings)) + 5)'`);
        } else if (msg.action === 'down') {
          exec(`osascript -e 'set volume output volume ((output volume of (get volume settings)) - 5)'`);
        } else if (msg.action === 'mute') {
          exec(`osascript -e 'set volume output muted not (output muted of (get volume settings))'`);
        }
      } else if (isWindows) {
        // Windows volume control using media keys
        if (msg.action === 'up') {
          exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
        } else if (msg.action === 'down') {
          exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
        } else if (msg.action === 'mute') {
          exec('powershell -command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"');
        }
      }
      break;

    case 'shortcut':
      if (msg.shortcut) {
        executeShortcut(msg.shortcut);
      }
      break;

    case 'appmode':
      if (msg.app && msg.action && appShortcuts[msg.app]) {
        const shortcut = appShortcuts[msg.app][msg.action];
        if (shortcut) {
          executeShortcut(shortcut);
        }
      }
      break;

    case 'quickaction':
      if (msg.id && quickActions[msg.id]) {
        executeShortcut(quickActions[msg.id].shortcut);
      }
      break;

    case 'customshortcut':
      if (msg.name && customShortcuts[msg.name]) {
        executeShortcut(customShortcuts[msg.name]);
      }
      break;

    case 'clipboard':
      if (msg.action === 'get') {
        return { text: getClipboard() };
      } else if (msg.action === 'set' && msg.text) {
        setClipboard(msg.text);
      }
      break;

    case 'monitor':
      if (msg.action === 'switch' && msg.id) {
        switchMonitor(msg.id);
      }
      break;

    case 'wake':
      if (msg.mac) {
        wakeOnLan(msg.mac, msg.broadcast);
      }
      break;
  }
}

// Express server
const expressApp = express();
const httpServer = http.createServer(expressApp);  // For local Electron window
const httpsServer = https.createServer(sslOptions, expressApp);  // For phones (gyroscope)

expressApp.use(express.json({ limit: '10mb' }));

// Session validation middleware - protects all endpoints except root QR page and license API
expressApp.use((req, res, next) => {
  // Allow QR page and license endpoints without session
  if (req.path === '/' || req.path.startsWith('/api/license')) return next();

  // Check session token from query param or header
  const token = req.query.s || req.headers['x-session'];
  if (token !== SESSION_TOKEN) {
    return res.status(403).json({ error: 'Invalid session' });
  }
  next();
});

// Command endpoint
expressApp.post('/cmd', (req, res) => {
  const deviceId = req.headers['x-device-id'] || req.ip;
  const result = handleCommand(req.body, deviceId);
  res.json({ ok: true, ...result });
});

// Screenshot endpoint
expressApp.get('/screenshot', (req, res) => {
  takeScreenshot((data, err) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json({ image: data });
    }
  });
});

// Screen preview endpoint
expressApp.get('/preview', (req, res) => {
  getScreenPreview((data, err) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json({ image: data });
    }
  });
});

// Monitors endpoint
expressApp.get('/monitors', (req, res) => {
  res.json({ monitors: getMonitors() });
});

// Clipboard endpoints
expressApp.get('/clipboard', (req, res) => {
  res.json({ text: getClipboard() });
});

expressApp.post('/clipboard', (req, res) => {
  if (req.body.text) {
    setClipboard(req.body.text);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'No text provided' });
  }
});

// Volume endpoint
expressApp.get('/volume', (req, res) => {
  exec(`osascript -e 'output volume of (get volume settings)'`, (err, stdout) => {
    const volume = parseInt(stdout) || 50;
    exec(`osascript -e 'output muted of (get volume settings)'`, (err2, stdout2) => {
      const muted = stdout2.trim() === 'true';
      res.json({ volume, muted });
    });
  });
});

// Active app endpoint
expressApp.get('/activeapp', (req, res) => {
  getActiveApp((app) => {
    res.json({ app });
  });
});

// Presenter notes endpoint
expressApp.get('/presenternotes', (req, res) => {
  getActiveApp((app) => {
    if (app === 'Keynote Presenting' || app === 'Keynote') {
      exec(`osascript -e 'tell application "Keynote"
        try
          set currentSlide to current slide of front document
          set slideNum to slide number of currentSlide
          set totalSlides to count of slides of front document
          set theNotes to presenter notes of currentSlide
          return (slideNum as string) & "|" & (totalSlides as string) & "|" & theNotes
        on error
          return "0|0|"
        end try
      end tell'`, (err, stdout) => {
        const parts = (stdout || '0|0|').trim().split('|');
        res.json({ slide: parseInt(parts[0]) || 0, total: parseInt(parts[1]) || 0, notes: parts.slice(2).join('|') || '' });
      });
    } else if (app === 'PowerPoint Presenting' || app === 'Microsoft PowerPoint') {
      exec(`osascript -e 'tell application "Microsoft PowerPoint"
        try
          set totalSlides to count of slides of active presentation
          set theSlideNum to 1
          set theNotes to ""
          try
            set theSlideNum to slide number of slide of slide show view of slide show window 1
          on error
            try
              set theSlideNum to slide number of slide of view of active window
            end try
          end try
          try
            set theSlide to slide theSlideNum of active presentation
            set notesPage to notes page of theSlide
            set notesShapes to shapes of notesPage
            repeat with s in notesShapes
              try
                if has text frame of s then
                  set shapeText to content of text range of text frame of s
                  if length of shapeText > length of theNotes then
                    set theNotes to shapeText
                  end if
                end if
              end try
            end repeat
          end try
          return (theSlideNum as string) & "|" & (totalSlides as string) & "|" & theNotes
        on error errMsg
          return "1|1|"
        end try
      end tell'`, (err, stdout) => {
        const output = (stdout || '1|1|').trim();
        const parts = output.split('|');
        res.json({ slide: parseInt(parts[0]) || 1, total: parseInt(parts[1]) || 1, notes: parts.slice(2).join('|').trim() || '' });
      });
    } else {
      res.json({ notes: '', slide: 0, total: 0 });
    }
  });
});

// Gyro laser pointer - moves cursor based on phone tilt
let laserActiveServer = false;
let laserDisplayId = null; // Which display to show laser on
let laserDisplay = null;

function createLaserWindow(display) {
  if (laserWindow) return;

  laserDisplay = display || screen.getPrimaryDisplay();
  const { x: dispX, y: dispY, width, height } = laserDisplay.bounds;

  laserWindow = new BrowserWindow({
    width: 30,
    height: 30,
    x: dispX + Math.round(width / 2),
    y: dispY + Math.round(height / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    resizable: false,
    webPreferences: { nodeIntegration: false }
  });

  laserWindow.setIgnoreMouseEvents(true);
  laserWindow.loadURL('data:text/html,<html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh"><div style="width:20px;height:20px;background:red;border-radius:50%;box-shadow:0 0 10px red,0 0 20px red,0 0 30px red"></div></body></html>');
}

function destroyLaserWindow() {
  if (laserWindow) {
    laserWindow.close();
    laserWindow = null;
  }
  laserDisplay = null;
}

// Set which display to use for laser (by display id)
expressApp.post('/laser-display', (req, res) => {
  const { displayId } = req.body;
  laserDisplayId = displayId;
  res.json({ status: 'ok', displayId });
});

expressApp.post('/laser', (req, res) => {
  const { action, x, y } = req.body;

  // Use selected display, or primary if none selected
  let targetDisplay;
  if (laserDisplayId) {
    targetDisplay = screen.getAllDisplays().find(d => d.id === laserDisplayId);
  }
  if (!targetDisplay) {
    // Default to display where cursor currently is
    const cursorPos = screen.getCursorScreenPoint();
    targetDisplay = screen.getDisplayNearestPoint(cursorPos);
  }

  const { x: dispX, y: dispY } = targetDisplay.bounds;
  const { width: screenWidth, height: screenHeight } = targetDisplay.bounds;

  if (action === 'start') {
    laserActiveServer = true;
    createLaserWindow(targetDisplay);
    res.json({ status: 'started', display: targetDisplay.id });
  } else if (action === 'stop') {
    laserActiveServer = false;
    destroyLaserWindow();
    res.json({ status: 'stopped' });
  } else if (action === 'absolute' && laserActiveServer) {
    // x, y are 0-1 relative coordinates within the target display
    const screenX = dispX + Math.round(x * screenWidth);
    const screenY = dispY + Math.round(y * screenHeight);

    // Clamp to display bounds
    const clampedX = Math.max(dispX, Math.min(dispX + screenWidth - 30, screenX));
    const clampedY = Math.max(dispY, Math.min(dispY + screenHeight - 30, screenY));

    // Move laser dot
    if (laserWindow) {
      laserWindow.setPosition(clampedX, clampedY);
    }

    // Also move mouse cursor
    if (robot) {
      robot.moveMouse(clampedX + 15, clampedY + 15);
    } else {
      exec(`${getCliclickPath()} m:${clampedX + 15},${clampedY + 15}`);
    }
    res.json({ x: clampedX, y: clampedY });
  } else {
    res.json({ status: 'inactive' });
  }
});

// Session history endpoint
expressApp.get('/history', (req, res) => {
  res.json({ history: sessionHistory.slice(-20) });
});

// Devices endpoint
expressApp.get('/devices', (req, res) => {
  res.json({ devices: Array.from(connectedDevices.values()) });
});

// Register device
expressApp.post('/register', (req, res) => {
  const deviceId = req.body.id || `device_${Date.now()}`;
  const deviceInfo = {
    id: deviceId,
    name: req.body.name || 'Unknown Device',
    connectedAt: new Date().toISOString()
  };
  connectedDevices.set(deviceId, deviceInfo);
  logSession(deviceId, 'connected');
  res.json({ ok: true, deviceId });
});

// Quick actions endpoints
expressApp.get('/quickactions', (req, res) => {
  res.json({ actions: quickActions });
});

expressApp.post('/quickactions', (req, res) => {
  if (req.body.actions) {
    quickActions = req.body.actions;
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'No actions provided' });
  }
});

// Custom shortcuts endpoints
expressApp.get('/shortcuts', (req, res) => {
  res.json({ shortcuts: customShortcuts });
});

expressApp.post('/shortcuts', (req, res) => {
  if (req.body.shortcuts) {
    customShortcuts = req.body.shortcuts;
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'No shortcuts provided' });
  }
});

// File upload (for small files)
expressApp.post('/upload', (req, res) => {
  if (req.body.filename && req.body.data) {
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const filePath = path.join(downloadsPath, req.body.filename);
    const buffer = Buffer.from(req.body.data, 'base64');
    fs.writeFileSync(filePath, buffer);
    res.json({ ok: true, path: filePath });
  } else {
    res.status(400).json({ error: 'Missing filename or data' });
  }
});

// Chunked upload storage
const chunkedUploads = new Map();

// Start chunked upload
expressApp.post('/upload/start', (req, res) => {
  const { filename, totalSize, totalChunks } = req.body;
  if (!filename || !totalChunks) {
    return res.status(400).json({ error: 'Missing filename or totalChunks' });
  }

  const uploadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const tempDir = path.join(os.tmpdir(), 'orbitxe_uploads', uploadId);
  fs.mkdirSync(tempDir, { recursive: true });

  chunkedUploads.set(uploadId, {
    filename,
    totalSize,
    totalChunks,
    receivedChunks: 0,
    tempDir,
    startTime: Date.now()
  });

  res.json({ ok: true, uploadId });
});

// Upload chunk
expressApp.post('/upload/chunk', (req, res) => {
  const { uploadId, chunkIndex, data } = req.body;

  const upload = chunkedUploads.get(uploadId);
  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  try {
    const chunkPath = path.join(upload.tempDir, `chunk_${chunkIndex}`);
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(chunkPath, buffer);
    upload.receivedChunks++;

    res.json({ ok: true, received: upload.receivedChunks, total: upload.totalChunks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete chunked upload
expressApp.post('/upload/complete', (req, res) => {
  const { uploadId } = req.body;

  const upload = chunkedUploads.get(uploadId);
  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  try {
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const filePath = path.join(downloadsPath, upload.filename);
    const writeStream = fs.createWriteStream(filePath);

    // Combine chunks in order
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkPath = path.join(upload.tempDir, `chunk_${i}`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
      fs.unlinkSync(chunkPath); // Delete chunk after writing
    }

    writeStream.end();

    // Cleanup
    fs.rmdirSync(upload.tempDir);
    chunkedUploads.delete(uploadId);

    const duration = ((Date.now() - upload.startTime) / 1000).toFixed(1);
    res.json({ ok: true, path: filePath, duration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel chunked upload
expressApp.post('/upload/cancel', (req, res) => {
  const { uploadId } = req.body;

  const upload = chunkedUploads.get(uploadId);
  if (upload) {
    try {
      fs.rmSync(upload.tempDir, { recursive: true, force: true });
    } catch (e) {}
    chunkedUploads.delete(uploadId);
  }

  res.json({ ok: true });
});

// License API endpoints
expressApp.get('/api/license', (req, res) => {
  res.json({
    tier: currentLicense.tier,
    email: currentLicense.email,
    expiresAt: currentLicense.expiresAt,
    isPro: ['trial', 'pro', 'lifetime'].includes(currentLicense.tier),
    platform: platformName // 'mac', 'windows', or 'linux'
  });
});

expressApp.post('/api/license/activate', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  const validation = await validateLicense(token);
  if (!validation || !validation.valid) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const license = validation.license;
  currentLicense = {
    tier: license.tier || 'trial',
    email: validation.user?.email,
    expiresAt: license.trialEndsAt || license.expiresAt,
    token: token
  };
  saveLicense();

  res.json({
    success: true,
    tier: currentLicense.tier,
    email: currentLicense.email,
    expiresAt: currentLicense.expiresAt
  });
});

expressApp.post('/api/license/signout', (req, res) => {
  currentLicense = { tier: 'free', email: null, expiresAt: null, token: null };
  saveLicense();
  res.json({ success: true });
});

// Restore purchase by email - checks cloud server
expressApp.post('/api/license/restore', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    // Check cloud server for this email's subscription
    const cloudRes = await fetch(`${CLOUD_API}/api/license/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    if (!cloudRes.ok) {
      const err = await cloudRes.json();
      return res.status(404).json({ error: err.error || 'No subscription found' });
    }

    const data = await cloudRes.json();

    if (data.tier && data.tier !== 'free') {
      currentLicense = {
        tier: data.tier,
        email: email,
        expiresAt: data.expiresAt,
        token: null
      };
      saveLicense();
      return res.json({ success: true, tier: data.tier });
    }

    res.status(404).json({ error: 'No active subscription found' });
  } catch (e) {
    console.error('Restore error:', e.message);
    res.status(500).json({ error: 'Could not connect to server' });
  }
});

// Remote control page
expressApp.get('/remote', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(getRemoteHTML());
});

// QR page
expressApp.get('/', async (req, res) => {
  const localQR = await QRCode.toDataURL(secureRemoteUrl, { width: 280 });
  res.send(getQRPageHTML(localQR));
});

// Create window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 480,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: { nodeIntegration: false }
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);
  // Allow window to close normally - app will quit via window-all-closed
}

// Create tray
function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAGDSURBVFiF7dYxS0JRGMbx/70q6BLR1hA0OkQQbQ1Bn6GhL9HQ3BcIWhrCpaXBL9DQEE0NDm1BCDQ0REM4iGhIXFRIvae3Qbj35nW4V4J8tsPhnOf9n+ec+x4J/ntJw4NZoB8YA3qAGPAJ5IEX4NJ9wE0gwH+CXfMasATkCuzVBDBVKt7JAGaB5QLbFLBSKt7pwO+kCiRQIiEBZ4FewB8wYW7E0wBrgJXALHCtfP4CK6iy3A7YAz6Uj1dgebmBJPAGpIFDoAg0AlPAFNADxIEPwCmghqhPAjXAN2ADqAAqgR7gHSgGfIDXQD2QAJYLtH8C3gIF4AJoB5qAYuAHkOtqBbJAChgC2oAG4AfoVT5/kRRQAB6BYaAZ+EW1A3VKILsZuAIygE0gB7yqvXmgAMgBl6qCDLACJJWPZ4AJoBaoAuoIVvQCfJTRvg7slNE+CFwBaYLLJgKHQA0wAjwBn6r3HYnA/+DfDi0D58A6cE9wwCLwDNwCDwQH7AfWE3zxvwDbzg3M+UqmsgAAAABJRU5ErkJggg==');
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  updateTrayMenu();
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'OrbitXE Desktop', enabled: false },
    { type: 'separator' },
    { label: `Local: ${localIP}`, enabled: false },
    { label: `Devices: ${connectedDevices.size}`, enabled: false },
    { type: 'separator' },
    { label: 'Show QR Code', click: () => mainWindow.show() },
    { label: 'Quit', click: () => app.exit() }
  ]);
  tray.setContextMenu(menu);
}

// Remote HTML - Full-featured remote control
function getRemoteHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>OrbitXE Pro</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    :root{--accent:#00ff88;--bg:#0a0a0a;--surface:#1a1a1a;--surface2:#252525;--text:#fff;--text2:#888}
    html,body{height:100%;background:var(--bg);color:var(--text);font-family:-apple-system,sans-serif;overflow:hidden;touch-action:none;user-select:none}
    .app{display:flex;flex-direction:column;height:100%;padding:10px;padding-top:max(10px,env(safe-area-inset-top));padding-bottom:max(10px,env(safe-area-inset-bottom))}
    .header{display:flex;justify-content:space-between;align-items:center;padding:5px 10px;gap:10px}
    .logo{font-size:16px;font-weight:700}.logo span{color:var(--accent)}
    .status{font-size:11px;color:var(--text2)}.status.connected{color:var(--accent)}
    .laser-toggle{padding:6px 12px;background:var(--surface);border:none;border-radius:15px;color:var(--text);font-size:12px;cursor:pointer}
    .laser-toggle.active{background:#ef4444;color:#fff;animation:pulse 1s infinite}

    /* Tabs */
    .tabs{display:flex;gap:5px;padding:8px;overflow-x:auto;scrollbar-width:none}
    .tabs::-webkit-scrollbar{display:none}
    .tab{padding:8px 14px;background:var(--surface);border:none;border-radius:20px;color:var(--text2);font-size:12px;white-space:nowrap;cursor:pointer}
    .tab.active{background:var(--accent);color:#000}

    /* Tab content */
    .tab-content{flex:1;display:none;flex-direction:column;overflow:hidden}
    .tab-content.active{display:flex}

    /* Active app indicator */
    .active-app{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;background:var(--surface);border-radius:20px;margin:0 auto 8px;width:fit-content}
    .active-app-label{font-size:11px;color:var(--text2)}
    .active-app-name{font-size:12px;color:var(--accent);font-weight:500}

    /* Trackpad */
    .trackpad{flex:1;background:var(--surface);border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:180px;position:relative}
    .trackpad-hint{color:var(--text2);font-size:12px;position:absolute;top:50%;transform:translateY(-50%)}

    /* Context controls */
    .context-controls{display:none;padding:8px}
    .context-controls.active{display:block}
    .context-controls .context-title{font-size:11px;color:var(--text2);text-align:center;margin-bottom:6px}

    /* Presenter notes */
    .presenter-notes{margin-top:12px;background:var(--surface);border-radius:12px;overflow:hidden}
    .notes-header{padding:10px 12px;background:var(--surface2);display:flex;justify-content:space-between;align-items:center}
    .slide-info{font-size:13px;font-weight:600;color:var(--accent)}
    .notes-content{padding:12px;font-size:13px;color:var(--text2);line-height:1.5;max-height:200px;overflow-y:auto}
    .trackpad-actions{display:flex;gap:8px;margin-top:auto;padding:10px}
    .trackpad-btn{padding:12px 20px;background:var(--surface2);border:none;border-radius:10px;color:var(--text);font-size:13px}
    .trackpad-btn:active{background:var(--accent);color:#000}

    /* Buttons grid */
    .btn-grid{display:grid;gap:8px;padding:8px}
    .btn-grid.cols-2{grid-template-columns:1fr 1fr}
    .btn-grid.cols-3{grid-template-columns:1fr 1fr 1fr}
    .btn-grid.cols-4{grid-template-columns:1fr 1fr 1fr 1fr}
    .btn{padding:16px;background:var(--surface);border:none;border-radius:12px;color:var(--text);font-size:14px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px}
    .btn:active{background:var(--accent);color:#000}
    .btn.active{background:#ef4444;color:#fff;animation:pulse 1s infinite}
    .btn.primary{background:var(--accent);color:#000}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
    .btn .icon{font-size:20px}
    .btn .label{font-size:11px;color:var(--text2)}
    .btn:active .label{color:#000}

    /* Keyboard */
    .keyboard-native{display:flex;flex-direction:column;height:100%;padding:10px}
    .keyboard-header{text-align:center;padding:10px;color:var(--text2);font-size:12px}
    .keyboard-input{flex:1;width:100%;padding:16px;background:var(--surface);border:2px solid var(--surface2);border-radius:16px;color:var(--text);font-size:18px;outline:none;resize:none;min-height:120px}
    .keyboard-input:focus{border-color:var(--accent)}
    .keyboard-actions{display:flex;gap:8px;margin-top:12px}
    .keyboard-actions .btn{flex:1}

    /* Media controls */
    .media-main{display:flex;align-items:center;justify-content:center;gap:20px;padding:20px}
    .media-btn{width:60px;height:60px;background:var(--surface);border:none;border-radius:50%;color:var(--text);font-size:24px;display:flex;align-items:center;justify-content:center}
    .media-btn:active{background:var(--accent);color:#000}
    .media-btn.play{width:80px;height:80px;background:var(--accent);color:#000;font-size:32px}

    /* Volume slider */
    .volume-container{padding:20px}
    .volume-label{display:flex;justify-content:space-between;margin-bottom:10px;font-size:12px;color:var(--text2)}
    .volume-slider{width:100%;height:8px;-webkit-appearance:none;background:var(--surface);border-radius:4px;outline:none}
    .volume-slider::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;background:var(--accent);border-radius:50%;cursor:pointer}


    /* Screen preview */
    .preview-container{flex:1;display:flex;flex-direction:column;padding:10px}
    .preview-image{flex:1;background:var(--surface);border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .preview-image img{max-width:100%;max-height:100%;object-fit:contain}
    .preview-actions{display:flex;gap:8px;margin-top:10px}
    .preview-btn{flex:1;padding:12px;background:var(--surface);border:none;border-radius:10px;color:var(--text);font-size:13px}
    .preview-btn:active{background:var(--accent);color:#000}

    /* Clipboard */
    .clipboard-area{flex:1;display:flex;flex-direction:column;padding:10px;gap:10px}
    .clipboard-text{flex:1;width:100%;padding:12px;background:var(--surface);border:2px solid var(--surface2);border-radius:12px;color:var(--text);font-size:14px;resize:none;outline:none}
    .clipboard-text:focus{border-color:var(--accent)}
    .clipboard-actions{display:flex;gap:8px}

    /* Shortcuts */
    .shortcuts-list{flex:1;overflow-y:auto;padding:10px}
    .shortcut-item{display:flex;justify-content:space-between;align-items:center;padding:12px;background:var(--surface);border-radius:10px;margin-bottom:8px}
    .shortcut-name{font-size:14px}
    .shortcut-keys{font-size:12px;color:var(--text2);background:var(--surface2);padding:4px 8px;border-radius:4px}

    /* Settings */
    .settings-section{padding:15px;border-bottom:1px solid var(--surface2)}
    .settings-title{font-size:13px;color:var(--text2);margin-bottom:10px}
    .settings-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0}
    .settings-label{font-size:14px}
    .toggle{width:50px;height:28px;background:var(--surface2);border-radius:14px;position:relative;cursor:pointer}
    .toggle.on{background:var(--accent)}
    .toggle::after{content:'';position:absolute;width:24px;height:24px;background:#fff;border-radius:50%;top:2px;left:2px;transition:transform 0.2s}
    .toggle.on::after{transform:translateX(22px)}

    /* Files */
    .files-container{display:flex;flex-direction:column;height:100%;padding:10px}
    .files-header{text-align:center;padding:10px;color:var(--text2);font-size:13px}
    .file-drop{flex:1;min-height:150px;background:var(--surface);border:2px dashed var(--surface2);border-radius:16px;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .file-drop.dragover{border-color:var(--accent);background:rgba(0,255,136,0.1)}
    .file-drop-text{text-align:center;color:var(--text2);font-size:14px}
    .file-list{max-height:150px;overflow-y:auto;margin:10px 0}
    .file-item{display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--surface);border-radius:8px;margin-bottom:6px}
    .file-name{font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .file-size{font-size:11px;color:var(--text2);margin-left:10px}
    .file-remove{width:24px;height:24px;background:none;border:none;color:var(--text2);font-size:16px;cursor:pointer;margin-left:8px}
    .file-actions{margin-top:auto;padding-top:10px}
    .file-status{text-align:center;padding:10px;font-size:12px;color:var(--accent)}
    .file-info{text-align:center;font-size:11px;color:var(--text2);padding:5px}
    .file-progress{padding:10px 0}
    .progress-text{font-size:12px;color:var(--accent);text-align:center;margin-bottom:6px}
    .progress-bar{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden}
    .progress-fill{height:100%;background:var(--accent);width:0%;transition:width 0.2s}

    /* Monitors */
    .monitors-container{padding:10px}
    .monitor-item{display:flex;align-items:center;padding:15px;background:var(--surface);border-radius:12px;margin-bottom:8px;cursor:pointer}
    .monitor-item:active{background:var(--surface2)}
    .monitor-icon{width:40px;height:30px;background:var(--surface2);border-radius:4px;margin-right:12px;display:flex;align-items:center;justify-content:center;font-size:12px}
    .monitor-info{flex:1}
    .monitor-name{font-size:14px}
    .monitor-res{font-size:12px;color:var(--text2)}
    .monitor-primary{font-size:10px;color:var(--accent);background:rgba(0,255,136,0.2);padding:2px 6px;border-radius:4px}

    /* Pro badge */
    .pro-badge{font-size:9px;background:#f59e0b;color:#000;padding:2px 5px;border-radius:8px;margin-left:4px;font-weight:600}
    .tab.locked{opacity:0.7}
    .tab.locked .pro-badge{background:#666}

    /* Upgrade modal */
    .upgrade-modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:1000;align-items:center;justify-content:center;padding:20px}
    .upgrade-modal.active{display:flex}
    .upgrade-content{background:var(--surface);border-radius:20px;padding:30px;max-width:320px;width:100%;text-align:center}
    .upgrade-content h3{font-size:20px;margin-bottom:8px}
    .upgrade-content p{color:var(--text2);font-size:14px;margin-bottom:20px}
    .upgrade-features{text-align:left;margin-bottom:20px}
    .upgrade-features li{padding:8px 0;font-size:13px;display:flex;align-items:center;gap:8px}
    .upgrade-features li::before{content:'\\2713';color:var(--accent);font-weight:bold}
    .upgrade-btn{width:100%;padding:14px;background:var(--accent);color:#000;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px}
    .upgrade-btn:active{opacity:0.8}
    .upgrade-close{background:var(--surface2);color:var(--text)}
    .upgrade-price{font-size:24px;font-weight:700;color:var(--accent);margin-bottom:4px}
    .upgrade-period{font-size:12px;color:var(--text2);margin-bottom:16px}

    /* Account section in header */
    .account-btn{padding:6px 12px;background:var(--surface);border:none;border-radius:15px;color:var(--text);font-size:11px;cursor:pointer;display:flex;align-items:center;gap:4px}
    .account-btn.pro{background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff}
  </style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="logo">Orbit<span>XE</span> Pro</div>
    <button class="laser-toggle" id="laserBtn" style="display:none">Laser</button>
    <div class="status connected" id="status">Connected</div>
  </div>

  <div class="tabs" id="tabs">
    <button class="tab active" data-tab="trackpad">Trackpad</button>
    <button class="tab" data-tab="keyboard">Keyboard</button>
    <button class="tab" data-tab="media" data-pro="true">Media<span class="pro-badge">PRO</span></button>
    <button class="tab" data-tab="screen">Screen</button>
    <button class="tab" data-tab="clipboard">Clipboard</button>
    <button class="tab" data-tab="shortcuts">Shortcuts</button>
    <button class="tab" data-tab="monitors" data-pro="true">Monitors<span class="pro-badge">PRO</span></button>
    <button class="tab" data-tab="files" data-pro="true">Files<span class="pro-badge">PRO</span></button>
  </div>

  <!-- Upgrade Modal -->
  <div class="upgrade-modal" id="upgradeModal">
    <div class="upgrade-content" id="upgradeContent">
      <h3>Upgrade to Pro</h3>
      <p>Unlock all features with a Pro subscription</p>
      <div class="upgrade-price">$2.99<span style="font-size:14px;font-weight:400">/mo</span></div>
      <div class="upgrade-period">7-day free trial included</div>
      <ul class="upgrade-features">
        <li>Media controls (Spotify, Music, etc.)</li>
        <li>Multi-display support</li>
        <li>File sharing to Mac</li>
        <li>Custom shortcuts</li>
      </ul>
      <button class="upgrade-btn" onclick="window.open('https://orbitxe.com/upgrade','_blank')">Start Free Trial</button>
      <button class="upgrade-btn upgrade-close" onclick="showRestoreView()">Already Subscribed?</button>
      <button class="upgrade-btn upgrade-close" onclick="closeUpgradeModal()" style="margin-top:0">Maybe Later</button>
    </div>
    <div class="upgrade-content" id="restoreContent" style="display:none">
      <h3>Restore Purchase</h3>
      <p>Enter the email you used to subscribe</p>
      <input type="email" id="restoreEmail" placeholder="your@email.com" style="width:100%;padding:14px;background:var(--surface2);border:1px solid #444;border-radius:10px;color:var(--text);font-size:15px;margin-bottom:16px;outline:none">
      <button class="upgrade-btn" onclick="restorePurchase()">Restore</button>
      <button class="upgrade-btn upgrade-close" onclick="showUpgradeView()">Back</button>
      <div id="restoreStatus" style="margin-top:12px;font-size:13px;color:var(--text2)"></div>
    </div>
    <div class="upgrade-content" id="manageContent" style="display:none">
      <h3>Manage Subscription</h3>
      <p id="manageStatus" style="color:var(--accent)">You're subscribed to OrbitXE Pro</p>
      <div style="margin:20px 0">
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px">Signed in as:</div>
        <div id="manageEmail" style="font-size:15px;color:var(--text)">-</div>
      </div>
      <button class="upgrade-btn" onclick="openBillingPortal()">Manage on Web</button>
      <button class="upgrade-btn upgrade-close" onclick="closeUpgradeModal()">Close</button>
      <p style="margin-top:16px;font-size:11px;color:var(--text2)">Update payment, view invoices, or cancel</p>
    </div>
  </div>

  <!-- Trackpad Tab -->
  <div class="tab-content active" id="tab-trackpad">
    <div class="active-app" id="activeApp">
      <span class="active-app-label">Active:</span>
      <span class="active-app-name" id="activeAppName">Detecting...</span>
    </div>
    <div class="trackpad" id="trackpad">
      <span class="trackpad-hint">Swipe to move cursor</span>
    </div>
    <div class="context-controls" id="contextControls"></div>
    <div class="btn-grid cols-4" style="padding:8px">
      <button class="btn" data-mouse="rightclick"><span class="label">Right</span></button>
      <button class="btn" data-scroll="up"><span class="label">Scroll Up</span></button>
      <button class="btn" data-scroll="down"><span class="label">Scroll Dn</span></button>
      <button class="btn" data-mouse="doubleclick"><span class="label">Double</span></button>
    </div>
    <div class="btn-grid cols-4">
      <button class="btn" data-key="escape">Esc</button>
      <button class="btn" data-key="left">Prev</button>
      <button class="btn primary" data-key="enter">OK</button>
      <button class="btn" data-key="right">Next</button>
    </div>
  </div>

  <!-- Keyboard Tab -->
  <div class="tab-content" id="tab-keyboard">
    <div class="keyboard-native">
      <div class="keyboard-header">
        <span>Type with your native keyboard</span>
      </div>
      <textarea class="keyboard-input" id="textInput" placeholder="Tap here to type..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="keyboard-actions">
        <button class="btn" id="sendTextBtn">Send Text</button>
        <button class="btn" id="clearTextBtn">Clear</button>
      </div>
      <div class="btn-grid cols-4" style="margin-top:12px">
        <button class="btn" data-key="tab">Tab</button>
        <button class="btn" data-key="backspace">⌫</button>
        <button class="btn" data-key="enter">Enter ⏎</button>
        <button class="btn" data-key="escape">Esc</button>
      </div>
      <div class="btn-grid cols-4">
        <button class="btn" data-shortcut="cmd+c">⌘C</button>
        <button class="btn" data-shortcut="cmd+v">⌘V</button>
        <button class="btn" data-shortcut="cmd+x">⌘X</button>
        <button class="btn" data-shortcut="cmd+z">⌘Z</button>
      </div>
      <div class="btn-grid cols-4">
        <button class="btn" data-key="up">▲</button>
        <button class="btn" data-key="down">▼</button>
        <button class="btn" data-key="left">◀</button>
        <button class="btn" data-key="right">▶</button>
      </div>
    </div>
  </div>

  <!-- Media Tab -->
  <div class="tab-content" id="tab-media">
    <div class="media-main">
      <button class="media-btn" data-media="prev">|&lt;</button>
      <button class="media-btn play" data-media="playpause">||</button>
      <button class="media-btn" data-media="next">&gt;|</button>
    </div>
    <div class="volume-container">
      <div class="volume-label"><span>Volume</span><span id="volumeValue">50%</span></div>
      <input type="range" class="volume-slider" id="volumeSlider" min="0" max="100" value="50">
    </div>
    <div class="btn-grid cols-3">
      <button class="btn" data-volume="down">Vol -</button>
      <button class="btn" data-volume="mute">Mute</button>
      <button class="btn" data-volume="up">Vol +</button>
    </div>
  </div>

  <!-- Screen Tab -->
  <div class="tab-content" id="tab-screen">
    <div class="preview-container">
      <div class="preview-image" id="previewImage">
        <span style="color:var(--text2)">Tap Preview to see screen</span>
      </div>
      <div class="preview-actions">
        <button class="preview-btn" id="previewBtn">Preview</button>
        <button class="preview-btn" id="screenshotBtn">Screenshot</button>
      </div>
    </div>
  </div>

  <!-- Clipboard Tab -->
  <div class="tab-content" id="tab-clipboard">
    <div class="clipboard-area">
      <textarea class="clipboard-text" id="clipboardText" placeholder="Clipboard content will appear here..."></textarea>
      <div class="clipboard-actions">
        <button class="btn" id="clipboardGet" style="flex:1">Get from Mac</button>
        <button class="btn primary" id="clipboardSet" style="flex:1">Send to Mac</button>
      </div>
    </div>
  </div>

  <!-- Shortcuts Tab -->
  <div class="tab-content" id="tab-shortcuts">
    <div class="shortcuts-list">
      <div class="shortcut-item" data-shortcut="cmd+c"><span class="shortcut-name">Copy</span><span class="shortcut-keys">⌘C</span></div>
      <div class="shortcut-item" data-shortcut="cmd+v"><span class="shortcut-name">Paste</span><span class="shortcut-keys">⌘V</span></div>
      <div class="shortcut-item" data-shortcut="cmd+x"><span class="shortcut-name">Cut</span><span class="shortcut-keys">⌘X</span></div>
      <div class="shortcut-item" data-shortcut="cmd+z"><span class="shortcut-name">Undo</span><span class="shortcut-keys">⌘Z</span></div>
      <div class="shortcut-item" data-shortcut="cmd+shift+z"><span class="shortcut-name">Redo</span><span class="shortcut-keys">⌘⇧Z</span></div>
      <div class="shortcut-item" data-shortcut="cmd+a"><span class="shortcut-name">Select All</span><span class="shortcut-keys">⌘A</span></div>
      <div class="shortcut-item" data-shortcut="cmd+s"><span class="shortcut-name">Save</span><span class="shortcut-keys">⌘S</span></div>
      <div class="shortcut-item" data-shortcut="cmd+w"><span class="shortcut-name">Close Window</span><span class="shortcut-keys">⌘W</span></div>
      <div class="shortcut-item" data-shortcut="cmd+q"><span class="shortcut-name">Quit App</span><span class="shortcut-keys">⌘Q</span></div>
      <div class="shortcut-item" data-shortcut="cmd+tab"><span class="shortcut-name">Switch App</span><span class="shortcut-keys">⌘Tab</span></div>
      <div class="shortcut-item" data-shortcut="cmd+space"><span class="shortcut-name">Spotlight</span><span class="shortcut-keys">⌘Space</span></div>
      <div class="shortcut-item" data-shortcut="cmd+shift+3"><span class="shortcut-name">Screenshot Full</span><span class="shortcut-keys">⌘⇧3</span></div>
      <div class="shortcut-item" data-shortcut="cmd+shift+4"><span class="shortcut-name">Screenshot Select</span><span class="shortcut-keys">⌘⇧4</span></div>
      <div class="shortcut-item" data-shortcut="ctrl+cmd+q"><span class="shortcut-name">Lock Screen</span><span class="shortcut-keys">⌃⌘Q</span></div>
    </div>
  </div>

  <!-- Monitors Tab -->
  <div class="tab-content" id="tab-monitors">
    <div class="monitors-container" id="monitorsList">
      <div style="text-align:center;color:var(--text2);padding:40px">Loading monitors...</div>
    </div>
  </div>

  <!-- Files Tab -->
  <div class="tab-content" id="tab-files">
    <div class="files-container">
      <div class="files-header">Transfer files to your Mac</div>
      <div class="file-drop" id="fileDrop">
        <div class="file-drop-text">Tap to select files<br><span style="font-size:11px;color:var(--text2)">or drag and drop</span></div>
        <input type="file" id="fileInput" multiple style="display:none">
      </div>
      <div class="file-list" id="fileList"></div>
      <div class="file-actions">
        <button class="btn primary" id="uploadBtn" style="flex:1" disabled>Send to Mac</button>
      </div>
      <div class="file-progress" id="fileProgress" style="display:none">
        <div class="progress-text" id="progressText">0%</div>
        <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      </div>
      <div class="file-status" id="fileStatus"></div>
      <div class="file-info">Files are saved to your Downloads folder</div>
    </div>
  </div>
</div>

<script>
// Get session token from URL
const SESSION = new URLSearchParams(window.location.search).get('s') || '';

// License state
let license = { tier: 'free', isPro: false };

// Check if user has Pro access
const isPro = () => license.isPro;

// Fetch license on load
async function loadLicense() {
  try {
    const res = await fetch('/api/license');
    if (res.ok) {
      license = await res.json();
      updateProUI();
      updatePlatformUI();
    }
  } catch (e) {}
}

// Update UI based on platform (Mac vs Windows)
function updatePlatformUI() {
  const platform = license?.platform || 'mac';
  const isMac = platform === 'mac';
  const modKey = isMac ? '⌘' : 'Ctrl+';
  const osName = isMac ? 'Mac' : 'PC';

  // Refresh app contexts with correct platform shortcuts
  appContexts = getAppContexts();

  // Update keyboard shortcut buttons
  document.querySelectorAll('[data-shortcut]').forEach(el => {
    const shortcut = el.getAttribute('data-shortcut');
    if (shortcut.includes('cmd+')) {
      const key = shortcut.replace('cmd+', '').toUpperCase();
      const label = el.querySelector('.shortcut-keys');
      if (label) {
        label.textContent = modKey + key;
      } else if (el.textContent.includes('⌘') || el.textContent.includes('Ctrl+')) {
        el.textContent = modKey + key;
      }
    }
  });

  // Update "Get from Mac" / "Send to Mac" buttons
  const clipboardGet = document.getElementById('clipboardGet');
  const clipboardSet = document.getElementById('clipboardSet');
  const uploadBtn = document.getElementById('uploadBtn');
  const filesHeader = document.querySelector('.files-header');

  if (clipboardGet) clipboardGet.textContent = 'Get from ' + osName;
  if (clipboardSet) clipboardSet.textContent = 'Send to ' + osName;
  if (uploadBtn) uploadBtn.textContent = 'Send to ' + osName;
  if (filesHeader) filesHeader.textContent = 'Transfer files to your ' + osName;

  // Update upgrade modal text
  const fileShareText = document.querySelector('.upgrade-features li:nth-child(3)');
  if (fileShareText && fileShareText.textContent.includes('Mac')) {
    fileShareText.textContent = 'File sharing to ' + osName;
  }
}

// Update UI based on Pro status
function updateProUI() {
  document.querySelectorAll('.tab[data-pro]').forEach(tab => {
    if (isPro()) {
      tab.classList.remove('locked');
      tab.querySelector('.pro-badge').style.display = 'none';
    } else {
      tab.classList.add('locked');
      tab.querySelector('.pro-badge').style.display = '';
    }
  });
}

// Show upgrade modal
function showUpgradeModal() {
  // If user already has Pro/Lifetime, show manage view instead
  if (['pro', 'lifetime'].includes(license.tier)) {
    showManageView();
  } else {
    showUpgradeView();
  }
  document.getElementById('upgradeModal').classList.add('active');
  haptic.medium();
}

// Close upgrade modal
function closeUpgradeModal() {
  document.getElementById('upgradeModal').classList.remove('active');
  showUpgradeView();
}

// Show restore view
function showRestoreView() {
  document.getElementById('upgradeContent').style.display = 'none';
  document.getElementById('restoreContent').style.display = 'block';
  document.getElementById('manageContent').style.display = 'none';
  document.getElementById('restoreStatus').textContent = '';
}

// Show upgrade view
function showUpgradeView() {
  document.getElementById('upgradeContent').style.display = 'block';
  document.getElementById('restoreContent').style.display = 'none';
  document.getElementById('manageContent').style.display = 'none';
}

// Show manage subscription view
function showManageView() {
  document.getElementById('upgradeContent').style.display = 'none';
  document.getElementById('restoreContent').style.display = 'none';
  document.getElementById('manageContent').style.display = 'block';
  // Update status text
  const statusText = currentLicense.tier === 'lifetime'
    ? 'You have OrbitXE Lifetime'
    : "You're subscribed to OrbitXE Pro";
  document.getElementById('manageStatus').textContent = statusText;
  document.getElementById('manageEmail').textContent = currentLicense.email || '-';
}

// Open billing portal in browser
function openBillingPortal() {
  window.open('https://orbitxe.com/upgrade', '_blank');
}

// Restore purchase by email
async function restorePurchase() {
  const email = document.getElementById('restoreEmail').value.trim();
  const status = document.getElementById('restoreStatus');

  if (!email) {
    status.textContent = 'Please enter your email';
    status.style.color = '#ef4444';
    return;
  }

  status.textContent = 'Checking...';
  status.style.color = 'var(--text2)';

  try {
    const res = await fetch('/api/license/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      status.textContent = 'Pro activated!';
      status.style.color = 'var(--accent)';
      license = { tier: data.tier, isPro: true };
      updateProUI();
      setTimeout(closeUpgradeModal, 1500);
    } else {
      status.textContent = data.error || 'No subscription found for this email';
      status.style.color = '#ef4444';
    }
  } catch (e) {
    status.textContent = 'Connection error. Try again.';
    status.style.color = '#ef4444';
  }
}

// Load license immediately
loadLicense();

// API helper - includes session token
const send = (data) => fetch('/cmd?s=' + SESSION, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'x-session': SESSION},
  body: JSON.stringify(data)
}).catch(() => {});

// Enhanced haptic feedback patterns
const haptic = {
  light: () => navigator.vibrate?.([10]),
  medium: () => navigator.vibrate?.([20]),
  heavy: () => navigator.vibrate?.([40]),
  click: () => navigator.vibrate?.([5, 50, 10]),
  success: () => navigator.vibrate?.([10, 50, 10, 50, 20]),
  error: () => navigator.vibrate?.([50, 100, 50]),
  scroll: () => navigator.vibrate?.([3]),
  drag: () => navigator.vibrate?.([15, 30, 15])
};

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    // Check if Pro feature and not licensed
    if (tab.dataset.pro && !isPro()) {
      showUpgradeModal();
      return;
    }

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    haptic.light();

    // Load data for specific tabs
    if (tab.dataset.tab === 'monitors') loadMonitors();
    if (tab.dataset.tab === 'media') loadVolume();
  };
});

// Trackpad
const tp = document.getElementById('trackpad');
let lastT = null, moved = false, startT = 0, startX = 0, startY = 0;
let isDragging = false;

tp.ontouchstart = e => {
  e.preventDefault();
  const touch = e.touches[0];
  lastT = touch;
  startT = Date.now();
  startX = touch.clientX;
  startY = touch.clientY;
  moved = false;
};

tp.ontouchmove = e => {
  e.preventDefault();
  if (!lastT) return;
  const t = e.touches[0];
  const dx = t.clientX - lastT.clientX;
  const dy = t.clientY - lastT.clientY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    moved = true;
    send({type: 'mouse', x: dx, y: dy, action: isDragging ? 'drag' : 'move'});
  }
  lastT = t;
};

tp.ontouchend = e => {
  e.preventDefault();
  const elapsed = Date.now() - startT;
  if (!moved && elapsed < 200) {
    send({type: 'mouse', action: 'click'});
    haptic.click();
  } else if (!moved && elapsed >= 500) {
    // Long press = right click
    send({type: 'mouse', action: 'rightclick'});
    haptic.heavy();
  }
  if (isDragging) {
    send({type: 'mouse', action: 'dragend'});
    isDragging = false;
  }
  lastT = null;
};

// Two-finger scroll detection
tp.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    tp.dataset.twoFinger = 'true';
    tp.dataset.lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  }
}, {passive: false});

tp.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && tp.dataset.twoFinger === 'true') {
    e.preventDefault();
    const currentY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const deltaY = currentY - parseFloat(tp.dataset.lastY);
    if (Math.abs(deltaY) > 5) {
      send({type: 'scroll', deltaY: -deltaY * 2});
      tp.dataset.lastY = currentY;
    }
  }
}, {passive: false});

tp.addEventListener('touchend', e => {
  tp.dataset.twoFinger = 'false';
}, {passive: false});

// App context detection and controls
const activeAppName = document.getElementById('activeAppName');
const contextControls = document.getElementById('contextControls');

// App context shortcuts - returns platform-appropriate shortcuts
function getAppContexts() {
  const platform = license?.platform || 'mac';
  const mod = platform === 'mac' ? 'cmd' : 'ctrl';

  // These contexts work the same on both platforms (web apps, media keys)
  const commonContexts = {
    'YouTube': {buttons: [{label: 'Play', shortcut: 'k'}, {label: '-10s', shortcut: 'j'}, {label: '+10s', shortcut: 'l'}, {label: 'Full', shortcut: 'f'}]},
    'Netflix': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: 'left'}, {label: '+10s', shortcut: 'right'}, {label: 'Full', shortcut: 'f'}]},
    'Prime Video': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: 'left'}, {label: '+10s', shortcut: 'right'}, {label: 'Full', shortcut: 'f'}]},
    'Disney+': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: 'left'}, {label: '+10s', shortcut: 'right'}, {label: 'Full', shortcut: 'f'}]},
    'Hulu': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: 'left'}, {label: '+10s', shortcut: 'right'}, {label: 'Full', shortcut: 'f'}]},
    'Twitch': {buttons: [{label: 'Play', shortcut: 'space'}, {label: 'Mute', shortcut: 'm'}, {label: 'Full', shortcut: 'f'}, {label: 'Theater', shortcut: 'alt+t'}]},
    'Vimeo': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: 'left'}, {label: '+10s', shortcut: 'right'}, {label: 'Full', shortcut: 'f'}]},
    'Spotify Web': {buttons: [{label: 'Play', shortcut: 'space'}, {label: 'Prev', shortcut: 'shift+left'}, {label: 'Next', shortcut: 'shift+right'}, {label: 'Shuffle', shortcut: 's'}]},
    'Apple Music Web': {buttons: [{label: 'Play', shortcut: 'space'}, {label: 'Prev', shortcut: 'left'}, {label: 'Next', shortcut: 'right'}]},
    'SoundCloud': {buttons: [{label: 'Play', shortcut: 'space'}, {label: 'Prev', shortcut: 'shift+left'}, {label: 'Next', shortcut: 'shift+right'}, {label: 'Shuffle', shortcut: 's'}]},
    'GitHub': {buttons: [{label: 'Search', shortcut: 's'}, {label: 'Go File', shortcut: 't'}, {label: 'Code', shortcut: 'gc'}, {label: 'Issues', shortcut: 'gi'}]},
    'Keynote Presenting': {buttons: [{label: 'Prev', shortcut: 'left'}, {label: 'Next', shortcut: 'right'}, {label: 'End', shortcut: 'escape'}], presenting: true},
    'PowerPoint Presenting': {buttons: [{label: 'Prev', shortcut: 'left'}, {label: 'Next', shortcut: 'right'}, {label: 'End', shortcut: 'escape'}], presenting: true},
    'Preview Slideshow': {buttons: [{label: 'Prev', shortcut: 'left'}, {label: 'Next', shortcut: 'right'}, {label: 'End', shortcut: 'escape'}]}
  };

  // Platform-specific contexts
  const platformContexts = {
    'Safari': {buttons: [{label: 'Back', shortcut: mod+'+'}, {label: 'Fwd', shortcut: mod+'+]'}, {label: 'Reload', shortcut: mod+'+r'}, {label: 'New Tab', shortcut: mod+'+t'}]},
    'Google Chrome': {buttons: [{label: 'Back', shortcut: 'alt+left'}, {label: 'Fwd', shortcut: 'alt+right'}, {label: 'Reload', shortcut: mod+'+r'}, {label: 'New Tab', shortcut: mod+'+t'}]},
    'Microsoft Edge': {buttons: [{label: 'Back', shortcut: 'alt+left'}, {label: 'Fwd', shortcut: 'alt+right'}, {label: 'Reload', shortcut: mod+'+r'}, {label: 'New Tab', shortcut: mod+'+t'}]},
    'Firefox': {buttons: [{label: 'Back', shortcut: 'alt+left'}, {label: 'Fwd', shortcut: 'alt+right'}, {label: 'Reload', shortcut: mod+'+r'}, {label: 'New Tab', shortcut: mod+'+t'}]},
    'Spotify': {buttons: [{label: 'Play', shortcut: 'space'}, {label: 'Prev', shortcut: mod+'+left'}, {label: 'Next', shortcut: mod+'+right'}, {label: 'Shuffle', shortcut: mod+'+s'}]},
    'Music': {buttons: [{label: 'Play', shortcut: 'space'}, {label: 'Prev', shortcut: mod+'+left'}, {label: 'Next', shortcut: mod+'+right'}]},
    'TV': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: mod+'+left'}, {label: '+10s', shortcut: mod+'+right'}, {label: 'Full', shortcut: mod+'+ctrl+f'}]},
    'VLC': {buttons: [{label: 'Play', shortcut: 'space'}, {label: '-10s', shortcut: mod+'+left'}, {label: '+10s', shortcut: mod+'+right'}, {label: 'Full', shortcut: mod+'+f'}]},
    'Keynote': {buttons: [{label: 'Present', shortcut: mod+'+alt+p'}, {label: 'Save', shortcut: mod+'+s'}, {label: 'Undo', shortcut: mod+'+z'}, {label: 'Redo', shortcut: mod+'+shift+z'}]},
    'Microsoft PowerPoint': {buttons: [{label: 'Present', shortcut: 'f5'}, {label: 'Save', shortcut: mod+'+s'}, {label: 'Undo', shortcut: mod+'+z'}, {label: 'Redo', shortcut: mod+'+y'}]},
    'zoom.us': {buttons: [{label: 'Mute', shortcut: 'alt+a'}, {label: 'Video', shortcut: 'alt+v'}, {label: 'Share', shortcut: 'alt+s'}, {label: 'Chat', shortcut: 'alt+h'}]},
    'Zoom': {buttons: [{label: 'Mute', shortcut: 'alt+a'}, {label: 'Video', shortcut: 'alt+v'}, {label: 'Share', shortcut: 'alt+s'}, {label: 'Chat', shortcut: 'alt+h'}]},
    'Code': {buttons: [{label: 'Save', shortcut: mod+'+s'}, {label: 'Find', shortcut: mod+'+f'}, {label: 'Term', shortcut: 'ctrl+grave'}, {label: 'Palette', shortcut: mod+'+shift+p'}]},
    'VS Code': {buttons: [{label: 'Save', shortcut: mod+'+s'}, {label: 'Find', shortcut: mod+'+f'}, {label: 'Term', shortcut: 'ctrl+grave'}, {label: 'Palette', shortcut: mod+'+shift+p'}]},
    'Xcode': {buttons: [{label: 'Run', shortcut: mod+'+r'}, {label: 'Stop', shortcut: mod+'+.'}, {label: 'Build', shortcut: mod+'+b'}, {label: 'Find', shortcut: mod+'+shift+f'}]},
    'Finder': {buttons: [{label: 'New', shortcut: mod+'+n'}, {label: 'Copy', shortcut: mod+'+c'}, {label: 'Paste', shortcut: mod+'+v'}, {label: 'Delete', shortcut: mod+'+backspace'}]},
    'File Explorer': {buttons: [{label: 'New', shortcut: mod+'+n'}, {label: 'Copy', shortcut: mod+'+c'}, {label: 'Paste', shortcut: mod+'+v'}, {label: 'Delete', shortcut: 'delete'}]},
    'Preview': {buttons: [{label: 'Zoom+', shortcut: mod+'+='}, {label: 'Zoom-', shortcut: mod+'+-'}, {label: 'Rotate', shortcut: mod+'+r'}, {label: 'Actual', shortcut: mod+'+0'}]},
    'Photos': {buttons: [{label: 'Edit', shortcut: 'return'}, {label: 'Info', shortcut: mod+'+i'}, {label: 'Delete', shortcut: mod+'+backspace'}, {label: 'Share', shortcut: mod+'+shift+e'}]},
    'Google Slides': {buttons: [{label: 'Present', shortcut: mod+'+return'}, {label: 'Prev', shortcut: 'left'}, {label: 'Next', shortcut: 'right'}, {label: 'End', shortcut: 'escape'}]},
    'Figma': {buttons: [{label: 'Zoom+', shortcut: mod+'+='}, {label: 'Zoom-', shortcut: mod+'+-'}, {label: 'Hand', shortcut: 'h'}, {label: 'Move', shortcut: 'v'}]}
  };

  return {...commonContexts, ...platformContexts};
}

// Initialize appContexts - will be updated when license loads
let appContexts = getAppContexts();

let currentDetectedApp = '';
let appPollInterval = null;
let notesPollInterval = null;

function updateContextControls(appName) {
  if (appName === currentDetectedApp) return;
  currentDetectedApp = appName;
  activeAppName.textContent = appName || 'Unknown';

  const ctx = appContexts[appName];
  if (ctx && ctx.buttons) {
    let html = '<div class="btn-grid cols-4">' +
      ctx.buttons.map(b => '<button class="btn context-btn" data-shortcut="' + b.shortcut + '">' + b.label + '</button>').join('') +
      '</div>';

    // Add notes panel for presenter modes
    if (ctx.presenting) {
      html += '<div class="presenter-notes" id="presenterNotes">' +
        '<div class="notes-header"><span class="slide-info" id="slideInfo">Slide -/-</span></div>' +
        '<div class="notes-content" id="notesContent">Loading notes...</div>' +
        '</div>';
      startNotesPolling();
    } else {
      stopNotesPolling();
    }

    contextControls.innerHTML = html;
    contextControls.classList.add('active');

    document.querySelectorAll('.context-btn').forEach(btn => {
      btn.onclick = () => {
        send({type: 'shortcut', shortcut: btn.dataset.shortcut});
        haptic.medium();
        // Refresh notes after navigation
        if (ctx.presenting && (btn.textContent === 'Prev' || btn.textContent === 'Next')) {
          setTimeout(pollNotes, 300);
        }
      };
    });
  } else {
    contextControls.innerHTML = '';
    contextControls.classList.remove('active');
    stopNotesPolling();
  }
}

function pollNotes() {
  fetch('/presenternotes?s=' + SESSION).then(r => r.json()).then(data => {
    const slideInfo = document.getElementById('slideInfo');
    const notesContent = document.getElementById('notesContent');
    if (slideInfo && notesContent) {
      slideInfo.textContent = 'Slide ' + data.slide + '/' + data.total;
      notesContent.textContent = data.notes || '(No notes for this slide)';
    }
  }).catch(() => {});
}

function startNotesPolling() {
  if (!notesPollInterval) {
    pollNotes();
    notesPollInterval = setInterval(pollNotes, 2000);
  }
}

function stopNotesPolling() {
  if (notesPollInterval) {
    clearInterval(notesPollInterval);
    notesPollInterval = null;
  }
}

function pollActiveApp() {
  fetch('/activeapp?s=' + SESSION).then(r => r.json()).then(data => {
    updateContextControls(data.app);
  }).catch(() => {});
}

// Start polling when on trackpad tab
function startAppPolling() {
  if (!appPollInterval) {
    pollActiveApp();
    appPollInterval = setInterval(pollActiveApp, 2000);
  }
}

function stopAppPolling() {
  if (appPollInterval) {
    clearInterval(appPollInterval);
    appPollInterval = null;
  }
}

// Start polling immediately
startAppPolling();

// Buttons
document.querySelectorAll('[data-key]').forEach(b => {
  b.onclick = () => { send({type: 'key', key: b.dataset.key}); haptic.medium(); };
});

document.querySelectorAll('[data-scroll]').forEach(b => {
  b.onclick = () => { send({type: 'scroll', deltaY: b.dataset.scroll === 'down' ? 100 : -100}); haptic.scroll(); };
});

document.querySelectorAll('[data-mouse]').forEach(b => {
  b.onclick = () => { send({type: 'mouse', action: b.dataset.mouse}); haptic.click(); };
});

document.querySelectorAll('[data-media]').forEach(b => {
  b.onclick = () => { send({type: 'media', action: b.dataset.media}); haptic.medium(); };
});

document.querySelectorAll('[data-volume]').forEach(b => {
  b.onclick = () => { send({type: 'volume', action: b.dataset.volume}); haptic.light(); loadVolume(); };
});

document.querySelectorAll('[data-shortcut]').forEach(b => {
  b.onclick = () => { send({type: 'shortcut', shortcut: b.dataset.shortcut}); haptic.medium(); };
});

// Native keyboard - text input
const textInput = document.getElementById('textInput');
const sendTextBtn = document.getElementById('sendTextBtn');
const clearTextBtn = document.getElementById('clearTextBtn');

sendTextBtn.onclick = () => {
  const text = textInput.value;
  if (text) {
    send({type: 'text', text: text});
    haptic.success();
    textInput.value = '';
  }
};

clearTextBtn.onclick = () => {
  textInput.value = '';
  haptic.light();
};

// Send each character as typed (real-time mode)
let lastLength = 0;
textInput.addEventListener('input', e => {
  const text = e.target.value;
  if (text.length > lastLength) {
    // New character typed
    const newChar = text.slice(lastLength);
    send({type: 'text', text: newChar});
    haptic.light();
  }
  lastLength = text.length;
});

textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send({type: 'key', key: 'enter'});
    haptic.medium();
  }
});

// Volume slider
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
volumeSlider.oninput = () => {
  volumeValue.textContent = volumeSlider.value + '%';
};
volumeSlider.onchange = () => {
  send({type: 'volume', value: parseInt(volumeSlider.value)});
  haptic.medium();
};

function loadVolume() {
  fetch('/volume?s=' + SESSION).then(r => r.json()).then(data => {
    volumeSlider.value = data.volume;
    volumeValue.textContent = data.volume + '%';
  }).catch(() => {});
}

// App modes
let currentApp = null;
document.querySelectorAll('.app-mode').forEach(mode => {
  mode.onclick = () => {
    const app = mode.dataset.app;
    document.querySelectorAll('.app-mode').forEach(m => m.classList.remove('active'));
    document.querySelectorAll('.app-controls').forEach(c => c.classList.remove('active'));

    if (currentApp === app) {
      currentApp = null;
    } else {
      mode.classList.add('active');
      const controls = document.querySelector('.app-controls[data-for="' + app + '"]');
      if (controls) controls.classList.add('active');
      currentApp = app;
    }
    haptic.medium();
  };
});

document.querySelectorAll('[data-appaction]').forEach(b => {
  b.onclick = () => {
    const [app, action] = b.dataset.appaction.split(':');
    send({type: 'appmode', app, action});
    haptic.medium();
  };
});

// Screen preview
const previewBtn = document.getElementById('previewBtn');
const screenshotBtn = document.getElementById('screenshotBtn');
const previewImage = document.getElementById('previewImage');

previewBtn.onclick = () => {
  previewImage.innerHTML = '<span style="color:var(--text2)">Loading...</span>';
  fetch('/preview?s=' + SESSION).then(r => r.json()).then(data => {
    previewImage.innerHTML = '<img src="' + data.image + '">';
    haptic.success();
  }).catch(() => {
    previewImage.innerHTML = '<span style="color:var(--text2)">Failed to load</span>';
    haptic.error();
  });
  haptic.medium();
};

screenshotBtn.onclick = () => {
  fetch('/screenshot?s=' + SESSION).then(r => r.json()).then(data => {
    previewImage.innerHTML = '<img src="' + data.image + '">';
    haptic.success();
  }).catch(() => {
    haptic.error();
  });
  haptic.heavy();
};

// Clipboard
const clipboardText = document.getElementById('clipboardText');
const clipboardGet = document.getElementById('clipboardGet');
const clipboardSet = document.getElementById('clipboardSet');

clipboardGet.onclick = () => {
  fetch('/clipboard?s=' + SESSION).then(r => r.json()).then(data => {
    clipboardText.value = data.text || '';
    haptic.success();
  }).catch(() => {
    haptic.error();
  });
  haptic.medium();
};

clipboardSet.onclick = () => {
  fetch('/clipboard', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text: clipboardText.value})
  }).then(() => {
    haptic.success();
  }).catch(() => {
    haptic.error();
  });
  haptic.medium();
};

// Shortcuts
document.querySelectorAll('.shortcut-item').forEach(item => {
  item.onclick = () => {
    send({type: 'shortcut', shortcut: item.dataset.shortcut});
    haptic.medium();
  };
});

// Monitors
function loadMonitors() {
  fetch('/monitors?s=' + SESSION).then(r => r.json()).then(data => {
    const list = document.getElementById('monitorsList');
    if (data.monitors.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text2);padding:40px">No monitors found</div>';
      return;
    }
    list.innerHTML = data.monitors.map(m => \`
      <div class="monitor-item" data-monitor="\${m.id}">
        <div class="monitor-icon">\${m.primary ? '★' : '☐'}</div>
        <div class="monitor-info">
          <div class="monitor-name">\${m.name}</div>
          <div class="monitor-res">\${m.width} × \${m.height}</div>
        </div>
        \${m.primary ? '<span class="monitor-primary">Primary</span>' : ''}
      </div>
    \`).join('');

    document.querySelectorAll('.monitor-item').forEach(item => {
      item.onclick = () => {
        send({type: 'monitor', action: 'switch', id: parseInt(item.dataset.monitor)});
        haptic.heavy();
      };
    });
  }).catch(() => {
    document.getElementById('monitorsList').innerHTML = '<div style="text-align:center;color:var(--text2);padding:40px">Failed to load</div>';
  });
}

// File transfer
const fileDrop = document.getElementById('fileDrop');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const uploadBtn = document.getElementById('uploadBtn');
const fileStatus = document.getElementById('fileStatus');
const fileProgress = document.getElementById('fileProgress');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
let selectedFiles = [];
let isUploading = false;

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

fileDrop.onclick = () => fileInput.click();

fileDrop.ondragover = (e) => {
  e.preventDefault();
  fileDrop.classList.add('dragover');
};

fileDrop.ondragleave = () => {
  fileDrop.classList.remove('dragover');
};

fileDrop.ondrop = (e) => {
  e.preventDefault();
  fileDrop.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
};

fileInput.onchange = (e) => {
  handleFiles(e.target.files);
};

function handleFiles(files) {
  selectedFiles = Array.from(files);
  renderFileList();
  uploadBtn.disabled = selectedFiles.length === 0;
  fileStatus.textContent = '';
  fileProgress.style.display = 'none';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function renderFileList() {
  fileList.innerHTML = selectedFiles.map((f, i) =>
    '<div class="file-item"><span class="file-name">' + f.name + '</span><span class="file-size">' + formatSize(f.size) + '</span><button class="file-remove" data-index="' + i + '">x</button></div>'
  ).join('');

  document.querySelectorAll('.file-remove').forEach(btn => {
    btn.onclick = () => {
      if (isUploading) return;
      selectedFiles.splice(parseInt(btn.dataset.index), 1);
      renderFileList();
      uploadBtn.disabled = selectedFiles.length === 0;
    };
  });
}

function updateProgress(percent, text) {
  progressFill.style.width = percent + '%';
  progressText.textContent = text || (percent.toFixed(0) + '%');
}

async function uploadFileChunked(file, fileIndex, totalFiles) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Start upload
  const startRes = await fetch('/upload/start?s=' + SESSION, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      filename: file.name,
      totalSize: file.size,
      totalChunks: totalChunks
    })
  });

  if (!startRes.ok) throw new Error('Failed to start upload');
  const { uploadId } = await startRes.json();

  // Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const chunkData = await readBlobAsBase64(chunk);

    const chunkRes = await fetch('/upload/chunk?s=' + SESSION, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        uploadId: uploadId,
        chunkIndex: i,
        data: chunkData
      })
    });

    if (!chunkRes.ok) throw new Error('Failed to upload chunk');

    // Update progress
    const fileProgress = ((i + 1) / totalChunks) * 100;
    const overallProgress = ((fileIndex + (i + 1) / totalChunks) / totalFiles) * 100;
    updateProgress(overallProgress, file.name + ' - ' + fileProgress.toFixed(0) + '%');
  }

  // Complete upload
  const completeRes = await fetch('/upload/complete?s=' + SESSION, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ uploadId: uploadId })
  });

  if (!completeRes.ok) throw new Error('Failed to complete upload');
  return await completeRes.json();
}

async function uploadFileSimple(file) {
  const data = await readBlobAsBase64(file);
  const res = await fetch('/upload?s=' + SESSION, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({filename: file.name, data: data})
  });
  if (!res.ok) throw new Error('Upload failed');
  return await res.json();
}

function readBlobAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

uploadBtn.onclick = async () => {
  if (selectedFiles.length === 0 || isUploading) return;

  isUploading = true;
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';
  fileProgress.style.display = 'block';
  fileStatus.textContent = '';

  let success = 0;
  let failed = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    const file = selectedFiles[i];
    try {
      if (file.size > 8 * 1024 * 1024) {
        // Use chunked upload for files > 8MB
        await uploadFileChunked(file, i, selectedFiles.length);
      } else {
        // Use simple upload for small files
        updateProgress(((i + 0.5) / selectedFiles.length) * 100, file.name);
        await uploadFileSimple(file);
        updateProgress(((i + 1) / selectedFiles.length) * 100);
      }
      success++;
    } catch (e) {
      console.error('Upload error:', e);
      failed++;
    }
  }

  isUploading = false;
  uploadBtn.textContent = 'Send to Mac';

  if (failed === 0) {
    updateProgress(100, 'Complete');
    fileStatus.textContent = success + ' file(s) sent to Downloads';
    haptic.success();
    selectedFiles = [];
    renderFileList();
  } else {
    fileStatus.textContent = success + ' sent, ' + failed + ' failed';
    haptic.error();
  }

  uploadBtn.disabled = selectedFiles.length === 0;
}

// Initial load
loadVolume();

// Laser pointer for mobile devices
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const laserBtn = document.getElementById('laserBtn');
let laserActive = false;

if (isMobile && laserBtn) {
  laserBtn.style.display = 'block';

  laserBtn.onclick = async () => {
    if (!laserActive) {
      // iOS requires permission request
      if (isIOS && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const permission = await DeviceOrientationEvent.requestPermission();
          if (permission !== 'granted') {
            alert('Gyroscope permission denied');
            return;
          }
        } catch (err) {
          alert('Gyroscope not available');
          return;
        }
      }

      // Start laser mode with calibration delay
      laserBtn.classList.add('active');
      laserBtn.textContent = 'Hold steady...';
      haptic.medium();

      // Start laser - point at screen center now
      laserActive = true;
      laserBaseAlpha = null; // Will calibrate on first orientation event
      laserBaseBeta = null;
      lastLaserSend = Date.now();
      laserBtn.textContent = 'LASER ON';
      haptic.success();
      fetch('/laser?s=' + SESSION, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'start'})
      });
      window.addEventListener('deviceorientation', handleLaserOrientation);
    } else {
      // Stop laser mode
      stopLaser();
    }
  };
}

function stopLaser() {
  laserActive = false;
  laserBaseAlpha = null;
  laserBaseBeta = null;
  if (laserBtn) {
    laserBtn.classList.remove('active');
    laserBtn.textContent = 'Laser';
  }
  window.removeEventListener('deviceorientation', handleLaserOrientation);
  fetch('/laser?s=' + SESSION, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'stop'})
  });
}

// Laser pointer using compass heading (alpha) for direction-based pointing
let laserBaseAlpha = null, laserBaseBeta = null;
let lastLaserSend = 0;
const LASER_RANGE = 30; // degrees of movement to cover full screen

function handleLaserOrientation(e) {
  if (!laserActive) return;

  let alpha = e.alpha; // Compass heading 0-360
  const beta = e.beta;  // Pitch -180 to 180 (90 = vertical)

  if (alpha === null || beta === null) return;

  // Calibrate on first reading - this position = screen center
  if (laserBaseAlpha === null) {
    laserBaseAlpha = alpha;
    laserBaseBeta = beta;
    return;
  }

  // Throttle to 30fps
  const now = Date.now();
  if (now - lastLaserSend < 33) return;
  lastLaserSend = now;

  // Calculate delta from calibration point (where user pointed at screen center)
  let deltaAlpha = alpha - laserBaseAlpha;
  // Handle compass wraparound (0/360 boundary)
  if (deltaAlpha > 180) deltaAlpha -= 360;
  if (deltaAlpha < -180) deltaAlpha += 360;

  const deltaBeta = beta - laserBaseBeta;

  // Map to 0-1: center is 0.5, LASER_RANGE degrees = full screen
  const x = Math.max(0, Math.min(1, 0.5 - (deltaAlpha / LASER_RANGE) * 0.5)); // inverted
  const y = Math.max(0, Math.min(1, 0.5 - (deltaBeta / LASER_RANGE) * 0.5));

  fetch('/laser?s=' + SESSION, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'absolute', x: x, y: y})
  });
}
</script>
</body>
</html>`;
}

// QR Page HTML
function getQRPageHTML(localQR) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>OrbitXE Pro</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .container{text-align:center;padding:30px}
    h1{font-size:32px;margin-bottom:5px}h1 span{color:#00ff88}
    .subtitle{color:#666;margin-bottom:25px;font-size:14px}
    .qr-box{background:#fff;padding:15px;border-radius:16px;display:inline-block;margin-bottom:15px}
    .qr-box img{display:block;width:220px;height:220px}
    .url{font-family:monospace;color:#00ff88;font-size:13px;margin-bottom:8px;word-break:break-all}
    .hint{color:#666;font-size:12px}
    .badge{display:inline-block;margin-top:20px;padding:6px 12px;background:#1a1a1a;border-radius:20px;font-size:11px;color:#666}
    .badge span{color:#00ff88}
    .features{margin-top:20px;text-align:left;display:inline-block}
    .feature{font-size:11px;color:#666;padding:3px 0}
    .feature::before{content:'✓ ';color:#00ff88}
  </style>
</head>
<body>
  <div class="container">
    <h1>Orbit<span>XE</span> Pro</h1>
    <p class="subtitle">Universal Device Control</p>
    <div class="qr-box"><img src="${localQR}"></div>
    <div class="url">${secureRemoteUrl}</div>
    <p class="hint">Scan with your phone • Same WiFi network</p>
    <div class="badge">Pro Features <span>Unlocked</span></div>
    <div class="features">
      <div class="feature">Full Keyboard & Gestures</div>
      <div class="feature">App-Specific Controls</div>
      <div class="feature">Screen Preview</div>
      <div class="feature">Clipboard Sync</div>
      <div class="feature">Voice Commands</div>
      <div class="feature">Multi-Monitor Support</div>
    </div>
  </div>
</body>
</html>`;
}

// Start
app.whenReady().then(() => {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`OrbitXE HTTP running on ${localIP}:${PORT}`);
  });
  httpsServer.listen(PORT + 1, '0.0.0.0', () => {
    console.log(`OrbitXE HTTPS running on ${localIP}:${PORT + 1} (for Android gyro)`);
    createWindow();
    createTray();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
app.on('activate', () => mainWindow?.show());
