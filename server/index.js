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

// Rooms: { roomId: { displays: Set, controllers: Set } }
const rooms = new Map();

// Create room
app.post('/api/rooms', (req, res) => {
  const roomId = nanoid(6).toUpperCase();
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

  rooms.set(roomId, {
    displays: new Set(),
    controllers: new Set(),
    activeTab: null,
    createdAt: Date.now()
  });

  res.json({
    roomId,
    controllerUrl: `${baseUrl}/remote/${roomId}`,
    websocketUrl: `${baseUrl.replace(/^http/, 'ws')}/ws/${roomId}`
  });
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

      // Handle join
      if (msg.type === 'join') {
        ws.role = msg.role;
        let room = rooms.get(roomId);

        if (!room) {
          room = { displays: new Set(), controllers: new Set(), activeTab: null, createdAt: Date.now() };
          rooms.set(roomId, room);
        }

        if (msg.role === 'display') {
          room.displays.add(ws);
        } else {
          room.controllers.add(ws);
        }

        // Send status to all
        broadcastStatus(room);
        ws.send(JSON.stringify({ type: 'joined', controllers: room.controllers.size, displays: room.displays.size }));
      }

      // Handle ping (keep-alive)
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Relay messages from phone to browser
      const room = rooms.get(roomId);
      if (!room) return;

      // Actions, mouse, keyboard, scroll - relay to displays
      if (['action', 'mouse', 'keyboard', 'scroll', 'showCursor'].includes(msg.type)) {
        console.log(`Relaying ${msg.type} to ${room.displays.size} displays:`, msg);
        const payload = JSON.stringify(msg);
        room.displays.forEach(d => {
          if (d.readyState === 1) d.send(payload);
        });
      }

      // Tab switching - relay to displays
      if (msg.type === 'switchTab') {
        const payload = JSON.stringify({ type: 'switchTab', tabId: msg.tabId });
        room.displays.forEach(d => {
          if (d.readyState === 1) d.send(payload);
        });
      }

      // Get tabs request - relay to displays
      if (msg.type === 'getTabs') {
        room.displays.forEach(d => {
          if (d.readyState === 1) d.send(JSON.stringify({ type: 'getTabs' }));
        });
      }

      // Active tab info / tab list - relay to controllers
      if (['activeTab', 'tabList'].includes(msg.type)) {
        console.log(`Relaying ${msg.type} to ${room.controllers.size} controllers`);
        if (msg.type === 'tabList') {
          console.log(`Tab count: ${msg.tabs?.length || 0}`);
        }
        const payload = JSON.stringify(msg);
        room.controllers.forEach(c => {
          if (c.readyState === 1) {
            console.log('Sending to controller');
            c.send(payload);
          }
        });
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

    broadcastStatus(room);

    // Clean up empty rooms after delay
    if (room.displays.size === 0 && room.controllers.size === 0) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.displays.size === 0 && r.controllers.size === 0) {
          rooms.delete(roomId);
        }
      }, 60000);
    }
  });
});

function broadcastStatus(room) {
  const status = JSON.stringify({
    type: 'status',
    controllers: room.controllers.size,
    displays: room.displays.size
  });
  room.displays.forEach(d => d.readyState === 1 && d.send(status));
  room.controllers.forEach(c => c.readyState === 1 && c.send(status));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ███████╗██╗  ██╗ ██████╗ ██████╗ ██╗   ██╗███████╗██╗  ██╗███████╗
║   ██╔════╝╚██╗██╔╝██╔═══██╗██╔══██╗██║   ██║██╔════╝╚██╗██╔╝██╔════╝
║   █████╗   ╚███╔╝ ██║   ██║██║  ██║██║   ██║███████╗ ╚███╔╝ █████╗
║   ██╔══╝   ██╔██╗ ██║   ██║██║  ██║██║   ██║╚════██║ ██╔██╗ ██╔══╝
║   ███████╗██╔╝ ██╗╚██████╔╝██████╔╝╚██████╔╝███████║██╔╝ ██╗███████╗
║   ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝
║                                                               ║
║   Universal Web Remote v2.0                                   ║
║   Server running on port ${PORT}                                 ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});
