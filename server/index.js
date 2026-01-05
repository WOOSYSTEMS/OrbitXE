import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Rooms: { roomId: { displays: Set, controllers: Set, profile: string } }
const rooms = new Map();

// Pre-built profiles for common web apps
const profiles = {
  universal: {
    name: 'Universal',
    description: 'Basic navigation for any website',
    layout: 'dpad+actions',
    mappings: {
      up: { type: 'key', key: 'ArrowUp' },
      down: { type: 'key', key: 'ArrowDown' },
      left: { type: 'key', key: 'ArrowLeft' },
      right: { type: 'key', key: 'ArrowRight' },
      a: { type: 'key', key: 'Enter' },
      b: { type: 'key', key: 'Escape' },
      x: { type: 'key', key: 'Space' },
      y: { type: 'key', key: 'Tab' }
    }
  },
  presentation: {
    name: 'Presentations',
    description: 'Google Slides, PowerPoint, Keynote',
    layout: 'swipe+actions',
    mappings: {
      swipeLeft: { type: 'key', key: 'ArrowRight' },
      swipeRight: { type: 'key', key: 'ArrowLeft' },
      swipeUp: { type: 'key', key: 'ArrowUp' },
      swipeDown: { type: 'key', key: 'ArrowDown' },
      a: { type: 'key', key: 'Enter' },
      b: { type: 'key', key: 'Escape' },
      tap: { type: 'key', key: 'ArrowRight' }
    }
  },
  video: {
    name: 'Video Player',
    description: 'YouTube, Netflix, Video controls',
    layout: 'media',
    mappings: {
      play: { type: 'key', key: ' ' },
      mute: { type: 'key', key: 'm' },
      fullscreen: { type: 'key', key: 'f' },
      seekBack: { type: 'key', key: 'ArrowLeft' },
      seekForward: { type: 'key', key: 'ArrowRight' },
      volumeUp: { type: 'key', key: 'ArrowUp' },
      volumeDown: { type: 'key', key: 'ArrowDown' },
      captions: { type: 'key', key: 'c' }
    }
  },
  meeting: {
    name: 'Video Calls',
    description: 'Zoom, Meet, Teams',
    layout: 'meeting',
    mappings: {
      mute: { type: 'shortcut', keys: ['Meta', 'd'] },
      video: { type: 'shortcut', keys: ['Meta', 'e'] },
      chat: { type: 'shortcut', keys: ['Meta', 'Shift', 'h'] },
      raise: { type: 'key', key: 'y' },
      leave: { type: 'shortcut', keys: ['Meta', 'w'] },
      share: { type: 'shortcut', keys: ['Meta', 'Shift', 's'] }
    }
  },
  scroll: {
    name: 'Scroll & Read',
    description: 'Articles, documents, browsing',
    layout: 'scroll',
    mappings: {
      scrollUp: { type: 'scroll', direction: 'up', amount: 300 },
      scrollDown: { type: 'scroll', direction: 'down', amount: 300 },
      pageUp: { type: 'key', key: 'PageUp' },
      pageDown: { type: 'key', key: 'PageDown' },
      top: { type: 'key', key: 'Home' },
      bottom: { type: 'key', key: 'End' },
      back: { type: 'shortcut', keys: ['Alt', 'ArrowLeft'] },
      forward: { type: 'shortcut', keys: ['Alt', 'ArrowRight'] }
    }
  },
  mouse: {
    name: 'Mouse Mode',
    description: 'Move cursor with phone tilt',
    layout: 'pointer',
    mappings: {
      motion: { type: 'mouse', mode: 'relative' },
      tap: { type: 'click', button: 'left' },
      hold: { type: 'click', button: 'right' },
      doubleTap: { type: 'doubleclick' }
    }
  }
};

// Create room
app.post('/api/rooms', (req, res) => {
  const roomId = nanoid(6).toUpperCase();
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const profile = req.body.profile || 'universal';

  // Determine if we should use secure WebSocket
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || baseUrl.startsWith('https');
  const wsProtocol = isSecure ? 'wss' : 'ws';
  const wsBase = baseUrl.replace(/^https?/, wsProtocol);

  rooms.set(roomId, {
    displays: new Set(),
    controllers: new Set(),
    profile: profile,
    createdAt: Date.now()
  });

  res.json({
    roomId,
    controllerUrl: `${baseUrl}/remote/${roomId}`,
    websocketUrl: `${wsBase}/ws/${roomId}`,
    profile: profiles[profile]
  });
});

// Get available profiles
app.get('/api/profiles', (req, res) => {
  res.json(profiles);
});

// Controller route
app.get('/remote/:roomId', (req, res) => {
  res.sendFile(join(__dirname, '../public/remote.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  const pathParts = req.url.split('/');
  const roomId = pathParts[pathParts.length - 1];

  ws.roomId = roomId;
  ws.role = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'join') {
        ws.role = msg.role;
        let room = rooms.get(roomId);

        if (!room) {
          room = { displays: new Set(), controllers: new Set(), profile: 'universal', createdAt: Date.now() };
          rooms.set(roomId, room);
        }

        if (msg.role === 'display') {
          room.displays.add(ws);
        } else {
          room.controllers.add(ws);
        }

        const status = {
          type: 'joined',
          controllers: room.controllers.size,
          displays: room.displays.size,
          profile: profiles[room.profile]
        };

        ws.send(JSON.stringify(status));

        // Notify all in room
        const update = { type: 'status', controllers: room.controllers.size, displays: room.displays.size };
        room.displays.forEach(d => d !== ws && d.send(JSON.stringify(update)));
        room.controllers.forEach(c => c !== ws && c.send(JSON.stringify(update)));
      }

      if (msg.type === 'action') {
        console.log('Server received action:', msg.action, 'from room:', roomId);
        const room = rooms.get(roomId);
        if (!room) {
          console.log('Room not found:', roomId);
          return;
        }

        console.log('Relaying to', room.displays.size, 'displays');
        const actionData = JSON.stringify({
          type: 'action',
          action: msg.action,
          value: msg.value,
          timestamp: Date.now()
        });

        room.displays.forEach(display => {
          if (display.readyState === 1) {
            console.log('Sending to display');
            display.send(actionData);
          }
        });
      }

      if (msg.type === 'gesture') {
        const room = rooms.get(roomId);
        if (!room) return;

        const gestureData = JSON.stringify({
          type: 'gesture',
          gesture: msg.gesture,
          data: msg.data,
          timestamp: Date.now()
        });

        room.displays.forEach(display => {
          if (display.readyState === 1) {
            display.send(gestureData);
          }
        });
      }

      if (msg.type === 'motion') {
        const room = rooms.get(roomId);
        if (!room) return;

        const motionData = JSON.stringify({
          type: 'motion',
          x: msg.x,
          y: msg.y,
          timestamp: Date.now()
        });

        room.displays.forEach(display => {
          if (display.readyState === 1) {
            display.send(motionData);
          }
        });
      }

      // Auto-detected site profile from browser
      if (msg.type === 'siteDetected') {
        console.log('Site detected:', msg.site, '-> profile:', msg.profile);
        const room = rooms.get(roomId);
        if (!room) return;

        // Send to all controllers (phones)
        const siteData = JSON.stringify({
          type: 'siteDetected',
          profile: profiles[msg.profile],
          profileKey: msg.profile,
          site: msg.site
        });
        room.controllers.forEach(c => c.send(siteData));
      }

      if (msg.type === 'setProfile') {
        console.log('Server received setProfile:', msg.profile, 'for room:', roomId);
        const room = rooms.get(roomId);
        if (!room) {
          console.log('Room not found for setProfile');
          return;
        }

        room.profile = msg.profile;
        const profileData = JSON.stringify({
          type: 'profileChanged',
          profile: profiles[msg.profile]
        });

        console.log('Broadcasting profile change to', room.displays.size, 'displays and', room.controllers.size, 'controllers');
        room.displays.forEach(d => d.send(profileData));
        room.controllers.forEach(c => c.send(profileData));
      }

    } catch (e) {
      console.error('Message error:', e);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (ws.role === 'display') {
      room.displays.delete(ws);
    } else {
      room.controllers.delete(ws);
    }

    const status = { type: 'status', controllers: room.controllers.size, displays: room.displays.size };
    room.displays.forEach(d => d.send(JSON.stringify(status)));
    room.controllers.forEach(c => c.send(JSON.stringify(status)));

    if (room.displays.size === 0 && room.controllers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║                                           ║
║   ███████╗██╗  ██╗ ██████╗ ██████╗ ██╗   ██╗███████╗    ██╗  ██╗███████╗
║   ██╔════╝╚██╗██╔╝██╔═══██╗██╔══██╗██║   ██║██╔════╝    ╚██╗██╔╝██╔════╝
║   █████╗   ╚███╔╝ ██║   ██║██║  ██║██║   ██║███████╗     ╚███╔╝ █████╗
║   ██╔══╝   ██╔██╗ ██║   ██║██║  ██║██║   ██║╚════██║     ██╔██╗ ██╔══╝
║   ███████╗██╔╝ ██╗╚██████╔╝██████╔╝╚██████╔╝███████║    ██╔╝ ██╗███████╗
║   ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝    ╚═╝  ╚═╝╚══════╝
║                                           ║
║   Universal Web Remote                    ║
║                                           ║
║   Server:  http://localhost:${PORT}          ║
║                                           ║
╚═══════════════════════════════════════════╝
  `);
});
