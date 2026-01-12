// OrbitXE Desktop Renderer - WebRTC Screen Streaming

// Signaling server (XE cloud server)
const SIGNALING_SERVER = 'https://orbitxe.com';

// WebRTC configuration
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

let computerId = '';
let tempCode = '';
let ws = null;
let stream = null;
let peerConnection = null;
let reconnectAttempts = 0;
let currentMonitorId = null;
let availableMonitors = [];
const MAX_RECONNECT_ATTEMPTS = 10;

// DOM Elements
const codeEl = document.getElementById('session-code');
const tempCodeEl = document.getElementById('temp-code');
const qrImg = document.getElementById('qr-image');
const urlEl = document.getElementById('connect-url');
const copyBtn = document.getElementById('btn-copy');
const waitingView = document.getElementById('waiting-view');
const connectedView = document.getElementById('connected-view');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const disconnectBtn = document.getElementById('btn-disconnect');
const timeEl = document.getElementById('connection-time');
const fpsEl = document.getElementById('stat-fps');

// Initialize the app with permanent computer ID and temp code
async function init() {
  // Get permanent computer ID
  computerId = await window.electronAPI.getComputerId();
  codeEl.textContent = computerId;

  // Get temporary session code (may be empty for OrbitXE)
  tempCode = await window.electronAPI.getTempCode();
  if (tempCode && tempCodeEl) {
    tempCodeEl.textContent = tempCode;
  } else if (tempCodeEl) {
    // Hide temp code section if not available
    tempCodeEl.parentElement.style.display = 'none';
  }

  // QR code points to remote page with code
  const connectUrl = `${SIGNALING_SERVER}/view/${computerId}`;
  urlEl.textContent = connectUrl;
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(connectUrl)}&bgcolor=0a0a0a&color=00ff88`;

  connect();
}

// Connect to signaling server
function connect() {
  statusText.textContent = 'Connecting...';
  statusDot?.classList.remove('on');

  const wsUrl = SIGNALING_SERVER.replace('https://', 'wss://').replace('http://', 'ws://');
  ws = new WebSocket(`${wsUrl}/?code=${computerId}&role=desktop`);

  ws.onopen = () => {
    console.log('Connected to signaling server');
    statusText.textContent = 'Ready - scan QR to connect';
    reconnectAttempts = 0;
  };

  ws.onmessage = async (e) => {
    try {
      const msg = JSON.parse(e.data);
      console.log('Received:', msg.type);

      // Forward draw messages to overlay
      if (msg.type && msg.type.startsWith('draw')) {
        console.log('Draw message:', msg.type);
        window.electronAPI.sendDrawMessage(msg);
        return;
      }

      switch (msg.type) {
        case 'phone-connected':
          statusText.textContent = 'Phone connected, starting stream...';
          window.electronAPI.setConnectionStatus(true);
          await sendMonitorList();
          await startWebRTC();
          break;

        case 'switch-monitor':
          await switchMonitor(msg.monitorId);
          break;

        case 'phone-disconnected':
          stopStream();
          statusText.textContent = 'Phone disconnected';
          window.electronAPI.setConnectionStatus(false);
          break;

        case 'webrtc-answer':
          if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            console.log('Set remote description (answer)');
          }
          break;

        case 'webrtc-ice':
          if (peerConnection && msg.candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
            console.log('Added ICE candidate');
          }
          break;

        // Handle control messages from phone
        case 'mouse-move':
          window.electronAPI.mouseMove(msg.x, msg.y);
          break;

        case 'mouse-click':
          window.electronAPI.mouseClick(msg.x, msg.y, msg.button || 'left');
          break;

        case 'mouse-scroll':
          window.electronAPI.mouseScroll(msg.deltaY);
          break;

        case 'key-press':
          window.electronAPI.keyPress(msg.key);
          break;

        case 'key-down':
          window.electronAPI.keyDown(msg.key);
          break;

        case 'mouse-move-delta':
          window.electronAPI.mouseMoveDelta(msg.deltaX, msg.deltaY);
          break;

        case 'mouse-click-current':
          window.electronAPI.mouseClickCurrent(msg.button || 'left');
          break;

        case 'mouse-double-click':
          window.electronAPI.mouseDoubleClick();
          break;

        case 'mouse-down':
          window.electronAPI.mouseDown();
          break;

        case 'mouse-up':
          window.electronAPI.mouseUp();
          break;

        case 'shortcut':
          window.electronAPI.shortcut(msg.key, msg.shift, msg.alt);
          break;

        case 'file-start':
          window.electronAPI.fileStart(msg.name, msg.size, msg.mimeType);
          break;

        case 'file-chunk':
          window.electronAPI.fileChunk(msg.data, msg.offset);
          break;

        case 'file-end':
          window.electronAPI.fileEnd(msg.name);
          break;

        case 'wake':
          window.electronAPI.wake();
          break;

        case 'lock-screen':
          window.electronAPI.lockScreen();
          break;

        case 'clipboard-get':
          const clipboardText = await window.electronAPI.clipboardRead();
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'clipboard-content',
              text: clipboardText
            }));
          }
          break;

        case 'clipboard-set':
          if (msg.text) {
            window.electronAPI.clipboardWrite(msg.text);
          }
          break;

        case 'file-request':
          await sendFileToPhone();
          break;

        // Annotation drawing messages
        case 'draw-start':
        case 'draw-move':
        case 'draw-end':
        case 'draw-shape':
          window.electronAPI.sendDrawMessage(msg);
          break;
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  };

  // Send file from desktop to phone
  const FILE_CHUNK_SIZE = 64 * 1024; // 64KB chunks

  async function sendFileToPhone() {
    try {
      const fileInfo = await window.electronAPI.selectFileToSend();
      if (!fileInfo) return;

      console.log('Sending file:', fileInfo.name, fileInfo.size, 'bytes');

      ws.send(JSON.stringify({
        type: 'file-to-phone-start',
        name: fileInfo.name,
        size: fileInfo.size
      }));

      let offset = 0;
      while (offset < fileInfo.size) {
        const chunkSize = Math.min(FILE_CHUNK_SIZE, fileInfo.size - offset);
        const chunkData = await window.electronAPI.readFileChunk(fileInfo.path, offset, chunkSize);

        if (!chunkData) {
          console.error('Failed to read chunk at offset', offset);
          break;
        }

        ws.send(JSON.stringify({
          type: 'file-to-phone-chunk',
          data: chunkData,
          offset: offset
        }));

        offset += chunkSize;
      }

      ws.send(JSON.stringify({
        type: 'file-to-phone-end',
        name: fileInfo.name
      }));

      console.log('File sent successfully');
    } catch (err) {
      console.error('Send file error:', err);
    }
  }

  ws.onclose = () => {
    console.log('WebSocket closed');
    statusText.textContent = 'Disconnected';
    statusDot?.classList.remove('on');

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = Math.min(1000 * reconnectAttempts, 5000);
      statusText.textContent = `Reconnecting in ${delay / 1000}s...`;
      setTimeout(connect, delay);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    statusText.textContent = 'Connection error';
  };
}

// Start WebRTC streaming
async function startWebRTC(monitorId = null) {
  try {
    // Get screen sources
    const sources = await window.electronAPI.getSources();
    if (!sources || sources.length === 0) {
      statusText.textContent = 'Screen Recording permission needed';
      return;
    }

    // Use specified monitor or first one
    const source = monitorId
      ? sources.find(s => s.id === monitorId) || sources[0]
      : sources[0];
    currentMonitorId = source.id;

    console.log('Capturing screen:', source.name);

    // Capture screen with high quality settings
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          minWidth: 1920,
          maxWidth: 3840,
          minHeight: 1080,
          maxHeight: 2160,
          minFrameRate: 30,
          maxFrameRate: 60
        }
      }
    });

    // Create peer connection
    peerConnection = new RTCPeerConnection(RTC_CONFIG);

    // Add stream tracks with high bitrate settings
    stream.getTracks().forEach(track => {
      const sender = peerConnection.addTrack(track, stream);
      console.log('Added track:', track.kind);

      // Set high bitrate for video
      if (track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 8000000; // 8 Mbps
        params.encodings[0].maxFramerate = 60;
        sender.setParameters(params).catch(e => console.log('Bitrate setting:', e.message));
      }
    });

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'webrtc-ice',
          candidate: event.candidate
        }));
      }
    };

    // Monitor connection state
    peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        showConnected();
        statusText.textContent = 'Streaming (WebRTC P2P)';
      } else if (peerConnection.connectionState === 'failed') {
        statusText.textContent = 'Connection failed';
        stopStream();
      }
    };

    // Create and send offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    ws.send(JSON.stringify({
      type: 'webrtc-offer',
      sdp: peerConnection.localDescription
    }));

    console.log('Sent WebRTC offer');
    statusText.textContent = 'Connecting peer-to-peer...';

  } catch (err) {
    console.error('WebRTC error:', err);
    statusText.textContent = 'Screen capture failed: ' + err.message;
  }
}

// Stop streaming
function stopStream() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  showWaiting();
}

// Send available monitors to phone
async function sendMonitorList() {
  const sources = await window.electronAPI.getSources();
  availableMonitors = sources;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'monitor-list',
      monitors: sources.map((s, i) => ({
        id: s.id,
        name: s.name,
        index: i
      }))
    }));
  }
}

// Switch to different monitor
async function switchMonitor(monitorId) {
  console.log('Switching to monitor:', monitorId);
  currentMonitorId = monitorId;
  stopStream();
  await startWebRTC(monitorId);
}

// UI State Management
let connectedAt = null;
let timeLoop = null;
let cursorLoop = null;

function showConnected() {
  waitingView.classList.add('hidden');
  connectedView.classList.add('active');
  statusDot?.classList.add('on');

  connectedAt = Date.now();
  timeLoop = setInterval(() => {
    const seconds = Math.floor((Date.now() - connectedAt) / 1000);
    if (seconds >= 60) {
      timeEl.textContent = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    } else {
      timeEl.textContent = `${seconds}s`;
    }
  }, 1000);

  // Start sending cursor position
  startCursorTracking();

  // Update FPS from WebRTC stats
  updateStats();
}

// Send cursor position to phone for magnifier
function startCursorTracking() {
  if (cursorLoop) clearInterval(cursorLoop);

  cursorLoop = setInterval(async () => {
    if (ws?.readyState === WebSocket.OPEN) {
      const pos = await window.electronAPI.getMousePosition();
      ws.send(JSON.stringify({
        type: 'cursor-position',
        x: pos.x,
        y: pos.y
      }));
    }
  }, 50); // 20 updates per second
}

function updateStats() {
  if (!peerConnection) return;

  peerConnection.getStats().then(stats => {
    stats.forEach(report => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        if (report.framesPerSecond) {
          fpsEl.textContent = Math.round(report.framesPerSecond);
        }
      }
    });
  });

  if (peerConnection) {
    setTimeout(updateStats, 1000);
  }
}

function showWaiting() {
  connectedView.classList.remove('active');
  waitingView.classList.remove('hidden');
  statusDot?.classList.remove('on');
  fpsEl.textContent = '--';

  if (timeLoop) {
    clearInterval(timeLoop);
    timeLoop = null;
  }

  if (cursorLoop) {
    clearInterval(cursorLoop);
    cursorLoop = null;
  }
}

// Event Handlers
copyBtn.onclick = async () => {
  const connectUrl = `${SIGNALING_SERVER}/view/${computerId}`;
  await navigator.clipboard.writeText(connectUrl);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => {
    copyBtn.textContent = 'Copy Link';
  }, 2000);
};

disconnectBtn.onclick = () => {
  stopStream();
  if (ws) {
    ws.close();
    ws = null;
  }
  setTimeout(init, 500);
};

// Handle wake complete - restart capture
window.electronAPI.onWakeComplete(() => {
  console.log('Wake complete, restarting capture...');
  setTimeout(async () => {
    if (peerConnection) {
      console.log('Force restarting WebRTC...');
      stopStream();
      setTimeout(() => startWebRTC(), 500);
    }
  }, 500);
});

// Start the app
init();
