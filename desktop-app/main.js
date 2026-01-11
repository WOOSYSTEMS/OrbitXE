const { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell, clipboard, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// Platform detection
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// ============ COMPUTER ID (Permanent, unique per machine) ============
const CONFIG_DIR = path.join(app.getPath('userData'), 'OrbitXE');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function getOrCreateComputerId() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.computerId) {
        console.log('Loaded computer ID:', config.computerId);
        return config.computerId;
      }
    }

    // Generate new computer ID (6 chars, alphanumeric)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let computerId = '';
    const randomBytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      computerId += chars[randomBytes[i] % chars.length];
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ computerId, createdAt: new Date().toISOString() }, null, 2));
    console.log('Generated new computer ID:', computerId);
    return computerId;
  } catch (err) {
    console.error('Failed to get/create computer ID:', err);
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }
}

let COMPUTER_ID = null;

// ============ TEMPORARY SESSION CODE (8 digits, changes each launch) ============
let TEMP_CODE = null;

function generateTempCode() {
  const digits = '0123456789';
  let code = '';
  const randomBytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += digits[randomBytes[i] % 10];
  }
  return code;
}

// Screen dimensions
let screenW = 0;
let screenH = 0;

// nut-js for cross-platform mouse/keyboard control
let nutMouse = null;
let nutKeyboard = null;
let Key = null;
let Button = null;

try {
  const nutjs = require('@nut-tree-fork/nut-js');
  nutMouse = nutjs.mouse;
  nutKeyboard = nutjs.keyboard;
  Key = nutjs.Key;
  Button = nutjs.Button;

  nutMouse.config.autoDelayMs = 0;
  nutMouse.config.mouseSpeed = 10000;

  console.log('nut-js loaded successfully');
} catch (e) {
  console.error('Failed to load nut-js:', e.message);
}

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isConnected = false;

// ============ TRAY ICON ============
function createTrayIcon(connected = false) {
  const zlib = require('zlib');
  const w = 18, h = 18;

  // "XE" pixel art
  const bitmap = [
    '..................',
    '..#...#..######...',
    '..#...#..#........',
    '...#.#...#........',
    '....#....####.....',
    '...#.#...#........',
    '..#...#..#........',
    '..#...#..######...',
    '..................',
  ];

  const pixels = [];
  for (let y = 0; y < h; y++) {
    pixels.push(0);
    for (let x = 0; x < w; x++) {
      let isPixel = false;
      if (y < bitmap.length && x < bitmap[y].length) {
        isPixel = bitmap[y][x] === '#';
      }
      if (isPixel) {
        if (connected) {
          pixels.push(0, 255, 136, 255); // Green
        } else {
          pixels.push(100, 100, 100, 255); // Gray
        }
      } else {
        pixels.push(0, 0, 0, 0); // Transparent
      }
    }
  }

  const deflated = zlib.deflateSync(Buffer.from(pixels));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);

  function createPNGChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type);
    const crcData = Buffer.concat([typeBuffer, data]);
    const crc = crc32(crcData);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc, 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    const table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const png = Buffer.concat([
    signature,
    createPNGChunk('IHDR', ihdrData),
    createPNGChunk('IDAT', deflated),
    createPNGChunk('IEND', Buffer.alloc(0))
  ]);

  return nativeImage.createFromBuffer(png);
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Device ID: ${COMPUTER_ID}`, enabled: false },
    { label: isConnected ? '● Connected' : '○ Waiting', enabled: false },
    { type: 'separator' },
    { label: 'Show Window', click: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    }},
    { type: 'separator' },
    { label: 'Quit OrbitXE', click: () => {
      app.isQuitting = true;
      app.quit();
    }}
  ]);

  tray.setContextMenu(contextMenu);
  tray.setImage(createTrayIcon(isConnected));
  tray.setToolTip(isConnected ? `OrbitXE - Connected (${COMPUTER_ID})` : `OrbitXE - ${COMPUTER_ID}`);
}

function setConnectionStatus(connected) {
  isConnected = connected;
  updateTrayMenu();

  if (connected) {
    createOverlayWindow();
    if (Notification.isSupported()) {
      new Notification({ title: 'OrbitXE', body: 'Phone connected', silent: true }).show();
    }
  } else {
    destroyOverlayWindow();
  }
}

function createTray() {
  try {
    tray = new Tray(createTrayIcon(false));
    updateTrayMenu();

    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      } else {
        createWindow();
      }
    });
  } catch (e) {
    console.error('Failed to create tray:', e);
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  screenW = display.size.width;
  screenH = display.size.height;
  console.log(`Screen size: ${screenW}x${screenH}`);

  mainWindow = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  screen.on('display-metrics-changed', () => {
    const d = screen.getPrimaryDisplay();
    screenW = d.size.width;
    screenH = d.size.height;
  });
}

// ============ ANNOTATION OVERLAY ============
function createOverlayWindow() {
  if (overlayWindow) return;

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;

  overlayWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile('overlay.html');

  if (isMac) {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  overlayWindow.on('closed', () => { overlayWindow = null; });
  console.log('Overlay window created');
}

function destroyOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

// ============ IPC HANDLERS ============

// Draw messages
ipcMain.on('draw-message', (event, msg) => {
  if (!overlayWindow && isConnected) createOverlayWindow();
  if (overlayWindow) overlayWindow.webContents.send('draw-message', msg);
});

// Screen sources
ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    console.error('Failed to get sources:', e.message);
    return [];
  }
});

// Screen size
ipcMain.handle('get-screen-size', () => ({ width: screenW, height: screenH }));

// Mouse position (normalized 0-1)
ipcMain.handle('get-mouse-position', async () => {
  if (!nutMouse) return { x: 0.5, y: 0.5 };
  try {
    const pos = await nutMouse.getPosition();
    return { x: pos.x / screenW, y: pos.y / screenH };
  } catch (err) {
    return { x: 0.5, y: 0.5 };
  }
});

// Mouse move (normalized)
ipcMain.on('mouse-move', async (e, { x, y }) => {
  if (!nutMouse) return;
  try {
    await nutMouse.setPosition({ x: Math.round(x * screenW), y: Math.round(y * screenH) });
  } catch (err) {
    console.error('Mouse move error:', err.message);
  }
});

// Mouse click
ipcMain.on('mouse-click', async (e, { x, y, button }) => {
  if (!nutMouse) return;
  try {
    await nutMouse.setPosition({ x: Math.round(x * screenW), y: Math.round(y * screenH) });
    await nutMouse.click(button === 'right' ? Button.RIGHT : Button.LEFT);
  } catch (err) {
    console.error('Mouse click error:', err.message);
  }
});

// Mouse scroll
ipcMain.on('mouse-scroll', async (e, { deltaY }) => {
  if (!nutMouse) return;
  try {
    const amount = Math.round(deltaY / 50);
    await nutMouse.scrollDown(amount);
  } catch (err) {
    console.error('Mouse scroll error:', err.message);
  }
});

// Mouse move delta (trackpad mode)
ipcMain.on('mouse-move-delta', async (e, { deltaX, deltaY }) => {
  if (!nutMouse) return;
  try {
    const pos = await nutMouse.getPosition();
    const newX = Math.max(0, Math.min(screenW, pos.x + deltaX));
    const newY = Math.max(0, Math.min(screenH, pos.y + deltaY));
    await nutMouse.setPosition({ x: newX, y: newY });
  } catch (err) {
    console.error('Mouse move delta error:', err.message);
  }
});

// Mouse click at current position
ipcMain.on('mouse-click-current', async (e, { button }) => {
  if (!nutMouse) return;
  try {
    await nutMouse.click(button === 'right' ? Button.RIGHT : Button.LEFT);
  } catch (err) {
    console.error('Mouse click current error:', err.message);
  }
});

// Double click
ipcMain.on('mouse-double-click', async () => {
  if (!nutMouse) return;
  try {
    await nutMouse.doubleClick(Button.LEFT);
  } catch (err) {
    console.error('Mouse double click error:', err.message);
  }
});

// Mouse down/up for drag
ipcMain.on('mouse-down', async () => {
  if (!nutMouse) return;
  try { await nutMouse.pressButton(Button.LEFT); } catch (err) {}
});

ipcMain.on('mouse-up', async () => {
  if (!nutMouse) return;
  try { await nutMouse.releaseButton(Button.LEFT); } catch (err) {}
});

// Key press (type character)
ipcMain.on('key-press', async (e, { key }) => {
  if (!nutKeyboard || !key) return;
  try {
    await nutKeyboard.type(key);
  } catch (err) {
    console.error('Key press error:', err.message);
  }
});

// Key mapping
const keyMap = {
  'Enter': 'Return', 'Backspace': 'Backspace', 'Tab': 'Tab', 'Escape': 'Escape',
  'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'Space': 'Space', 'Delete': 'Delete', 'Home': 'Home', 'End': 'End',
  'PageUp': 'PageUp', 'PageDown': 'PageDown',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
  'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12'
};

// Key down (special keys)
ipcMain.on('key-down', async (e, { key }) => {
  if (!nutKeyboard || !Key) return;
  const mapped = keyMap[key];
  if (!mapped) return;
  try {
    const nutKey = Key[mapped];
    if (nutKey !== undefined) {
      await nutKeyboard.pressKey(nutKey);
      await nutKeyboard.releaseKey(nutKey);
    }
  } catch (err) {
    console.error('Key down error:', err.message);
  }
});

// Keyboard shortcut
const modifierKey = isMac ? Key?.LeftSuper : Key?.LeftControl;

ipcMain.on('shortcut', async (e, { key, shift, alt }) => {
  if (!nutKeyboard || !Key) return;
  try {
    const keyChar = key.toUpperCase();
    const nutKey = Key[keyChar];
    if (nutKey === undefined) return;

    const modifiers = [modifierKey];
    if (shift) modifiers.push(Key.LeftShift);
    if (alt) modifiers.push(Key.LeftAlt);

    for (const mod of modifiers) await nutKeyboard.pressKey(mod);
    await nutKeyboard.pressKey(nutKey);
    await nutKeyboard.releaseKey(nutKey);
    for (const mod of modifiers.reverse()) await nutKeyboard.releaseKey(mod);
  } catch (err) {
    console.error('Shortcut error:', err.message);
  }
});

// ============ FILE TRANSFER ============
let currentFile = null;
let fileChunks = [];
const downloadsPath = path.join(os.homedir(), 'Desktop', 'OrbitXE Transfers');

if (!fs.existsSync(downloadsPath)) {
  fs.mkdirSync(downloadsPath, { recursive: true });
}

ipcMain.on('file-start', (e, { name, size, mimeType }) => {
  console.log(`Receiving file: ${name} (${size} bytes)`);
  currentFile = { name, size, mimeType };
  fileChunks = [];
});

ipcMain.on('file-chunk', (e, { data, offset }) => {
  fileChunks.push(Buffer.from(data, 'base64'));
});

ipcMain.on('file-end', (e, { name }) => {
  if (!currentFile) return;
  try {
    const fileBuffer = Buffer.concat(fileChunks);
    let filePath = path.join(downloadsPath, name);
    let counter = 1;
    while (fs.existsSync(filePath)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      filePath = path.join(downloadsPath, `${base} (${counter})${ext}`);
      counter++;
    }
    fs.writeFileSync(filePath, fileBuffer);
    console.log(`File saved: ${filePath}`);
    shell.showItemInFolder(filePath);
  } catch (err) {
    console.error('File save error:', err.message);
  }
  currentFile = null;
  fileChunks = [];
});

// File send (desktop → phone)
ipcMain.handle('select-file-to-send', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select file to send',
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  return { path: filePath, name: path.basename(filePath), size: stats.size };
});

ipcMain.handle('read-file-chunk', (e, { filePath, offset, size }) => {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
    fs.closeSync(fd);
    return buffer.slice(0, bytesRead).toString('base64');
  } catch (err) {
    console.error('Read file chunk error:', err.message);
    return null;
  }
});

// ============ CLIPBOARD ============
ipcMain.handle('clipboard-read', () => {
  try { return clipboard.readText(); } catch (err) { return ''; }
});

ipcMain.on('clipboard-write', (e, { text }) => {
  try { clipboard.writeText(text); } catch (err) {}
});

// ============ SYSTEM CONTROLS ============
ipcMain.on('wake', async () => {
  console.log('Wake screen requested');
  try {
    if (isMac) exec('caffeinate -u -t 1');
    if (nutKeyboard && Key) {
      await nutKeyboard.pressKey(Key.LeftShift);
      await nutKeyboard.releaseKey(Key.LeftShift);
    }
    if (nutMouse) {
      const pos = await nutMouse.getPosition();
      await nutMouse.setPosition({ x: pos.x + 1, y: pos.y });
      await nutMouse.setPosition({ x: pos.x, y: pos.y });
    }
    if (mainWindow) mainWindow.webContents.send('wake-complete');
  } catch (err) {
    console.error('Wake error:', err.message);
  }
});

ipcMain.on('lock-screen', async () => {
  console.log('Lock screen requested');
  try {
    if (isMac && nutKeyboard && Key) {
      await nutKeyboard.pressKey(Key.LeftControl, Key.LeftSuper, Key.Q);
      await nutKeyboard.releaseKey(Key.LeftControl, Key.LeftSuper, Key.Q);
    } else if (isWindows) {
      exec('rundll32.exe user32.dll,LockWorkStation');
    }
  } catch (err) {
    console.error('Lock screen error:', err.message);
  }
});

// ============ IDs ============
ipcMain.handle('get-computer-id', () => COMPUTER_ID);
ipcMain.handle('get-temp-code', () => TEMP_CODE);
ipcMain.on('connection-status', (e, { connected }) => setConnectionStatus(connected));

// ============ APP LIFECYCLE ============
app.whenReady().then(() => {
  COMPUTER_ID = getOrCreateComputerId();
  TEMP_CODE = generateTempCode();
  console.log('Computer ID:', COMPUTER_ID);
  console.log('Temp Code:', TEMP_CODE);

  if (isMac) app.dock.hide();

  createTray();
  createWindow();

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
    else createWindow();
  });
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; });
