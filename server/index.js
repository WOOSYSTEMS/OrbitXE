import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

// Import new modules
import {
  getUserById,
  getUserByEmail,
  getLicenseForUser,
  updateUserSubscription,
  createSubscription,
  updateSubscriptionStatus,
  getUserByStripeCustomerId,
  FEATURES
} from './db.js';
import { authenticateWithGoogle, verifyToken, authMiddleware } from './auth.js';
import {
  createCheckoutSession,
  createPortalSession,
  getCheckoutSession,
  constructWebhookEvent,
  stripe
} from './stripe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Stripe webhook needs raw body
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.log('Stripe webhook received (no secret configured, accepting all)');
    // In development without webhook secret, just accept
    return res.json({ received: true });
  }

  try {
    const event = constructWebhookEvent(req.body, signature);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId || session.client_reference_id;
        const planType = session.metadata?.planType;

        console.log('Checkout completed:', { userId, planType });

        if (userId) {
          const tier = planType === 'lifetime' ? 'lifetime' : 'pro';
          updateUserSubscription(userId, tier, session.customer);

          if (planType === 'monthly' && session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            createSubscription({
              userId,
              stripeSubscriptionId: subscription.id,
              planType: 'monthly',
              status: 'active',
              periodStart: new Date(subscription.current_period_start * 1000).toISOString(),
              periodEnd: new Date(subscription.current_period_end * 1000).toISOString()
            });
          } else if (planType === 'lifetime') {
            createSubscription({
              userId,
              stripeSubscriptionId: null,
              planType: 'lifetime',
              status: 'active',
              periodStart: new Date().toISOString(),
              periodEnd: null
            });
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          updateSubscriptionStatus(invoice.subscription, 'past_due');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        updateSubscriptionStatus(subscription.id, 'canceled', new Date().toISOString());

        // Downgrade user to free
        const user = getUserByStripeCustomerId(subscription.customer);
        if (user) {
          updateUserSubscription(user.id, 'free');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        if (subscription.status === 'active') {
          updateSubscriptionStatus(subscription.id, 'active');
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Rooms: { roomId: { displays: Set, controllers: Set } }
const rooms = new Map();

// Helper to get base URL
function getBaseUrl(req) {
  return process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ==================== AUTH ENDPOINTS ====================

// Google authentication
app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const result = await authenticateWithGoogle(token);
    res.json(result);
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: error.message });
  }
});

// Validate token and get license
app.get('/api/auth/validate', authMiddleware, (req, res) => {
  try {
    const user = getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const license = getLicenseForUser(user);

    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture_url
      },
      license
    });
  } catch (error) {
    console.error('Validate error:', error);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// ==================== PAYMENT ENDPOINTS ====================

// Create checkout session
app.post('/api/payment/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { planType } = req.body;

    if (!['monthly', 'lifetime'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    const user = getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const baseUrl = getBaseUrl(req);
    const session = await createCheckoutSession(user, planType, baseUrl);

    res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Get customer portal
app.get('/api/payment/portal', authMiddleware, async (req, res) => {
  try {
    const user = getUserById(req.userId);

    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    const baseUrl = getBaseUrl(req);
    const session = await createPortalSession(user.stripe_customer_id, `${baseUrl}/account`);

    res.json({ portalUrl: session.url });
  } catch (error) {
    console.error('Portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Check license by email (for desktop app restore)
app.post('/api/license/check', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const user = getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email' });
    }

    const license = getLicenseForUser(user);

    if (license.tier === 'free') {
      return res.status(404).json({ error: 'No active subscription' });
    }

    res.json({
      tier: license.tier,
      expiresAt: license.expiresAt || license.trialEndsAt
    });
  } catch (error) {
    console.error('License check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== EXISTING ROUTES ====================

// Create room
app.post('/api/rooms', (req, res) => {
  const roomId = nanoid(6).toUpperCase();
  const baseUrl = getBaseUrl(req);

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

// Privacy policy
app.get('/privacy', (req, res) => {
  res.sendFile(join(__dirname, '../public/privacy.html'));
});

// Terms of service
app.get('/terms', (req, res) => {
  res.sendFile(join(__dirname, '../public/terms.html'));
});

// Upgrade page
app.get('/upgrade', (req, res) => {
  res.sendFile(join(__dirname, '../public/upgrade.html'));
});

// Payment success/cancel pages
app.get('/payment/success', (req, res) => {
  res.sendFile(join(__dirname, '../public/payment-success.html'));
});

app.get('/payment/cancel', (req, res) => {
  res.sendFile(join(__dirname, '../public/payment-cancel.html'));
});

// ==================== TV DASHBOARD ====================

// TV Dashboard - auto create room
app.get('/tv', (req, res) => {
  const roomId = nanoid(6).toUpperCase();
  const baseUrl = getBaseUrl(req);

  rooms.set(roomId, {
    displays: new Set(),
    controllers: new Set(),
    tvDisplays: new Set(),
    activeTab: null,
    activeApp: null,
    createdAt: Date.now()
  });

  res.redirect(`/tv/${roomId}`);
});

// TV Dashboard with room ID
app.get('/tv/:roomId', (req, res) => {
  res.sendFile(join(__dirname, '../public/tv/dashboard.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// Get local network info for local sync
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal/loopback and non-IPv4
      if (iface.internal || iface.family !== 'IPv4') continue;
      ips.push({
        name,
        address: iface.address
      });
    }
  }
  return ips;
}

// Local network info endpoint
app.get('/api/network', (req, res) => {
  const ips = getLocalIPs();
  const port = process.env.PORT || 3000;
  const isLocal = !process.env.RAILWAY_PUBLIC_DOMAIN;

  // Prefer common interfaces: en0 (WiFi), en1, bridge (hotspot)
  const preferredOrder = ['en0', 'en1', 'bridge100', 'bridge0'];
  const sortedIPs = [...ips].sort((a, b) => {
    const aIdx = preferredOrder.indexOf(a.name);
    const bIdx = preferredOrder.indexOf(b.name);
    if (aIdx === -1 && bIdx === -1) return 0;
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  res.json({
    isLocal,
    port,
    localIPs: sortedIPs,
    // All available URLs
    localUrls: sortedIPs.map(ip => ({
      name: ip.name,
      url: `http://${ip.address}:${port}`
    })),
    // Primary local URL
    localUrl: sortedIPs.length > 0 ? `http://${sortedIPs[0].address}:${port}` : null,
    cloudUrl: process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null
  });
});

// ==================== WEBSOCKET ====================

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
          // If TV is already connected, notify this controller
          const hasTv = [...room.displays].some(d => d.subtype === 'tv');
          if (hasTv) {
            ws.send(JSON.stringify({ type: 'tvConnected', roomId }));
          }
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

      // Open new tab - relay to displays
      if (msg.type === 'openTab') {
        console.log('Opening tab:', msg.url);
        const payload = JSON.stringify({ type: 'openTab', url: msg.url });
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

      // showKeyboard - relay to controllers (phone)
      if (msg.type === 'showKeyboard') {
        console.log('Relaying showKeyboard to controllers');
        const payload = JSON.stringify({ type: 'showKeyboard' });
        room.controllers.forEach(c => {
          if (c.readyState === 1) c.send(payload);
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

      // ==================== TV DASHBOARD MESSAGES ====================

      // TV display joined - notify controllers
      if (msg.type === 'join' && msg.subtype === 'tv') {
        ws.subtype = 'tv';
        if (room.tvDisplays) {
          room.tvDisplays.add(ws);
        }
        // Notify controllers that TV is connected
        const tvNotify = JSON.stringify({ type: 'tvConnected', roomId });
        room.controllers.forEach(c => {
          if (c.readyState === 1) c.send(tvNotify);
        });
      }

      // D-pad navigation - relay to TV displays AND browser extension
      if (msg.type === 'dpad') {
        console.log('D-pad:', msg.direction);
        const payload = JSON.stringify(msg);
        // Send to TV displays
        room.displays.forEach(d => {
          if (d.readyState === 1 && d.subtype === 'tv') d.send(payload);
        });
        // Also send as action to browser extension (non-TV displays)
        const actionPayload = JSON.stringify({ type: 'action', action: msg.direction });
        room.displays.forEach(d => {
          if (d.readyState === 1 && !d.subtype) d.send(actionPayload);
        });
      }

      // Launch app - relay to TV displays
      if (msg.type === 'launchApp') {
        console.log('Launch app:', msg.appId);
        room.activeApp = msg.appId;
        const payload = JSON.stringify(msg);
        room.displays.forEach(d => {
          if (d.readyState === 1 && d.subtype === 'tv') d.send(payload);
        });
      }

      // Volume control - relay to TV displays
      if (msg.type === 'volume') {
        console.log('Volume:', msg.action);
        const payload = JSON.stringify(msg);
        room.displays.forEach(d => {
          if (d.readyState === 1 && d.subtype === 'tv') d.send(payload);
        });
      }

      // Voice search - relay to TV displays
      if (msg.type === 'voice') {
        console.log('Voice search:', msg.query);
        const payload = JSON.stringify(msg);
        room.displays.forEach(d => {
          if (d.readyState === 1 && d.subtype === 'tv') d.send(payload);
        });
      }

      // Home button - relay to TV displays
      if (msg.type === 'home') {
        console.log('Home button pressed');
        room.activeApp = null;
        const payload = JSON.stringify(msg);
        room.displays.forEach(d => {
          if (d.readyState === 1 && d.subtype === 'tv') d.send(payload);
        });
      }

      // TV state update - relay to controllers
      if (['tvState', 'nowPlaying'].includes(msg.type)) {
        const payload = JSON.stringify(msg);
        room.controllers.forEach(c => {
          if (c.readyState === 1) c.send(payload);
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
║    ██████╗ ██████╗ ██████╗ ██╗████████╗██╗  ██╗███████╗       ║
║   ██╔═══██╗██╔══██╗██╔══██╗██║╚══██╔══╝╚██╗██╔╝██╔════╝       ║
║   ██║   ██║██████╔╝██████╔╝██║   ██║    ╚███╔╝ █████╗         ║
║   ██║   ██║██╔══██╗██╔══██╗██║   ██║    ██╔██╗ ██╔══╝         ║
║   ╚██████╔╝██║  ██║██████╔╝██║   ██║   ██╔╝ ██╗███████╗       ║
║    ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝       ║
║                                                               ║
║   Universal Web Remote v2.0 + Pro Features                    ║
║   Server running on port ${PORT}                                 ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});
