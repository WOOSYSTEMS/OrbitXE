import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, '../orbitxe.db'));

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    google_id TEXT UNIQUE NOT NULL,
    name TEXT,
    picture_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    trial_started_at TEXT,
    trial_ends_at TEXT,
    subscription_tier TEXT DEFAULT 'trial',
    stripe_customer_id TEXT
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    stripe_subscription_id TEXT,
    plan_type TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_start TEXT,
    current_period_end TEXT,
    canceled_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
`);

// Feature definitions
export const FEATURES = {
  FREE: ['trackpad', 'scroll_buttons'],
  TRIAL: ['trackpad', 'scroll_buttons', 'keyboard', 'tab_switch', 'open_tab',
          'youtube', 'netflix', 'slides', 'zoom', 'meet', 'two_finger_scroll'],
  PRO: ['trackpad', 'scroll_buttons', 'keyboard', 'tab_switch', 'open_tab',
        'youtube', 'netflix', 'slides', 'zoom', 'meet', 'two_finger_scroll']
};

// User operations
export function createUser({ email, googleId, name, pictureUrl }) {
  const id = nanoid();
  const now = new Date().toISOString();
  const trialEnds = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const stmt = db.prepare(`
    INSERT INTO users (id, email, google_id, name, picture_url, trial_started_at, trial_ends_at, subscription_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'trial')
  `);

  stmt.run(id, email, googleId, name, pictureUrl, now, trialEnds);
  return getUserById(id);
}

export function getUserById(id) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

export function getUserByGoogleId(googleId) {
  const stmt = db.prepare('SELECT * FROM users WHERE google_id = ?');
  return stmt.get(googleId);
}

export function getUserByEmail(email) {
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email);
}

export function updateUserSubscription(userId, tier, stripeCustomerId = null) {
  const stmt = db.prepare(`
    UPDATE users
    SET subscription_tier = ?, stripe_customer_id = COALESCE(?, stripe_customer_id)
    WHERE id = ?
  `);
  stmt.run(tier, stripeCustomerId, userId);
  return getUserById(userId);
}

export function getLicenseForUser(user) {
  if (!user) {
    return { tier: 'free', features: FEATURES.FREE };
  }

  const tier = user.subscription_tier;

  // Check if trial is still active
  if (tier === 'trial') {
    const trialEnd = new Date(user.trial_ends_at);
    if (Date.now() > trialEnd.getTime()) {
      // Trial expired, update to free
      updateUserSubscription(user.id, 'free');
      return {
        tier: 'free',
        features: FEATURES.FREE,
        trialExpired: true
      };
    }
    return {
      tier: 'trial',
      features: FEATURES.TRIAL,
      trialEndsAt: user.trial_ends_at
    };
  }

  // Pro or lifetime
  if (tier === 'pro' || tier === 'lifetime') {
    const subscription = getActiveSubscription(user.id);
    return {
      tier,
      features: FEATURES.PRO,
      expiresAt: subscription?.current_period_end
    };
  }

  return { tier: 'free', features: FEATURES.FREE };
}

// Subscription operations
export function createSubscription({ userId, stripeSubscriptionId, planType, status, periodStart, periodEnd }) {
  const id = nanoid();
  const stmt = db.prepare(`
    INSERT INTO subscriptions (id, user_id, stripe_subscription_id, plan_type, status, current_period_start, current_period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, userId, stripeSubscriptionId, planType, status, periodStart, periodEnd);
  return getSubscriptionById(id);
}

export function getSubscriptionById(id) {
  const stmt = db.prepare('SELECT * FROM subscriptions WHERE id = ?');
  return stmt.get(id);
}

export function getActiveSubscription(userId) {
  const stmt = db.prepare(`
    SELECT * FROM subscriptions
    WHERE user_id = ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return stmt.get(userId);
}

export function getSubscriptionByStripeId(stripeSubscriptionId) {
  const stmt = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?');
  return stmt.get(stripeSubscriptionId);
}

export function updateSubscriptionStatus(stripeSubscriptionId, status, canceledAt = null) {
  const stmt = db.prepare(`
    UPDATE subscriptions
    SET status = ?, canceled_at = ?
    WHERE stripe_subscription_id = ?
  `);
  stmt.run(status, canceledAt, stripeSubscriptionId);
}

export function updateSubscriptionPeriod(stripeSubscriptionId, periodStart, periodEnd) {
  const stmt = db.prepare(`
    UPDATE subscriptions
    SET current_period_start = ?, current_period_end = ?
    WHERE stripe_subscription_id = ?
  `);
  stmt.run(periodStart, periodEnd, stripeSubscriptionId);
}

export function getUserByStripeCustomerId(stripeCustomerId) {
  const stmt = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');
  return stmt.get(stripeCustomerId);
}

export default db;
