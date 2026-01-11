const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Computer ID (permanent) and Temp Code (session)
  getComputerId: () => ipcRenderer.invoke('get-computer-id'),
  getTempCode: () => ipcRenderer.invoke('get-temp-code'),

  // Screen capture
  getSources: () => ipcRenderer.invoke('get-sources'),
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  getMousePosition: () => ipcRenderer.invoke('get-mouse-position'),

  // Mouse control
  mouseMove: (x, y) => ipcRenderer.send('mouse-move', { x, y }),
  mouseClick: (x, y, button) => ipcRenderer.send('mouse-click', { x, y, button }),
  mouseScroll: (deltaY) => ipcRenderer.send('mouse-scroll', { deltaY }),
  mouseMoveDelta: (deltaX, deltaY) => ipcRenderer.send('mouse-move-delta', { deltaX, deltaY }),
  mouseClickCurrent: (button) => ipcRenderer.send('mouse-click-current', { button }),
  mouseDoubleClick: () => ipcRenderer.send('mouse-double-click'),
  mouseDown: () => ipcRenderer.send('mouse-down'),
  mouseUp: () => ipcRenderer.send('mouse-up'),

  // Keyboard control
  keyPress: (key) => ipcRenderer.send('key-press', { key }),
  keyDown: (key) => ipcRenderer.send('key-down', { key }),
  shortcut: (key, shift, alt) => ipcRenderer.send('shortcut', { key, shift, alt }),

  // File transfer (phone → desktop)
  fileStart: (name, size, mimeType) => ipcRenderer.send('file-start', { name, size, mimeType }),
  fileChunk: (data, offset) => ipcRenderer.send('file-chunk', { data, offset }),
  fileEnd: (name) => ipcRenderer.send('file-end', { name }),

  // File send (desktop → phone)
  selectFileToSend: () => ipcRenderer.invoke('select-file-to-send'),
  readFileChunk: (filePath, offset, size) => ipcRenderer.invoke('read-file-chunk', { filePath, offset, size }),

  // System
  wake: () => ipcRenderer.send('wake'),
  onWakeComplete: (callback) => ipcRenderer.on('wake-complete', callback),
  lockScreen: () => ipcRenderer.send('lock-screen'),

  // Connection status (for tray icon)
  setConnectionStatus: (connected) => ipcRenderer.send('connection-status', { connected }),

  // Clipboard
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard-write', { text }),

  // Drawing/Annotation overlay
  sendDrawMessage: (msg) => ipcRenderer.send('draw-message', msg),
  onDrawMessage: (callback) => ipcRenderer.on('draw-message', (event, msg) => callback(msg))
});
