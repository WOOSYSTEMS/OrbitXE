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

  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    file_name TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    country TEXT,
    downloaded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_downloads_platform ON downloads(platform);
  CREATE INDEX IF NOT EXISTS idx_downloads_date ON downloads(downloaded_at);

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    viewed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views(viewed_at);
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

// ==================== ADMIN FUNCTIONS ====================

// Get all users with subscription info
export function getAllUsers() {
  const stmt = db.prepare(`
    SELECT u.*,
           s.plan_type as subscription_plan,
           s.status as subscription_status,
           s.current_period_end as subscription_ends
    FROM users u
    LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
    ORDER BY u.created_at DESC
  `);
  return stmt.all();
}

// Get user count by tier
export function getUserStats() {
  const stmt = db.prepare(`
    SELECT
      subscription_tier,
      COUNT(*) as count
    FROM users
    GROUP BY subscription_tier
  `);
  return stmt.all();
}

// Get all subscriptions
export function getAllSubscriptions() {
  const stmt = db.prepare(`
    SELECT s.*, u.email, u.name
    FROM subscriptions s
    JOIN users u ON s.user_id = u.id
    ORDER BY s.created_at DESC
  `);
  return stmt.all();
}

// Track download
export function trackDownload({ platform, fileName, ipAddress, userAgent, country }) {
  const stmt = db.prepare(`
    INSERT INTO downloads (platform, file_name, ip_address, user_agent, country)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(platform, fileName, ipAddress, userAgent, country);
}

// Get download stats
export function getDownloadStats() {
  const total = db.prepare('SELECT COUNT(*) as total FROM downloads').get();
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM downloads
    GROUP BY platform
  `).all();
  const last7Days = db.prepare(`
    SELECT DATE(downloaded_at) as date, COUNT(*) as count
    FROM downloads
    WHERE downloaded_at >= datetime('now', '-7 days')
    GROUP BY DATE(downloaded_at)
    ORDER BY date DESC
  `).all();
  const last30Days = db.prepare(`
    SELECT COUNT(*) as count
    FROM downloads
    WHERE downloaded_at >= datetime('now', '-30 days')
  `).get();

  return {
    total: total.total,
    byPlatform,
    last7Days,
    last30DaysTotal: last30Days.count
  };
}

// Get recent downloads
export function getRecentDownloads(limit = 50) {
  const stmt = db.prepare(`
    SELECT * FROM downloads
    ORDER BY downloaded_at DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

// Track page view
export function trackPageView({ page, ipAddress, userAgent, referrer }) {
  const stmt = db.prepare(`
    INSERT INTO page_views (page, ip_address, user_agent, referrer)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(page, ipAddress, userAgent, referrer);
}

// Get visitor stats
export function getVisitorStats() {
  const total = db.prepare('SELECT COUNT(*) as total FROM page_views').get();
  const uniqueVisitors = db.prepare('SELECT COUNT(DISTINCT ip_address) as count FROM page_views').get();
  const today = db.prepare(`
    SELECT COUNT(*) as count FROM page_views
    WHERE DATE(viewed_at) = DATE('now')
  `).get();
  const todayUnique = db.prepare(`
    SELECT COUNT(DISTINCT ip_address) as count FROM page_views
    WHERE DATE(viewed_at) = DATE('now')
  `).get();
  const last7Days = db.prepare(`
    SELECT DATE(viewed_at) as date, COUNT(*) as views, COUNT(DISTINCT ip_address) as visitors
    FROM page_views
    WHERE viewed_at >= datetime('now', '-7 days')
    GROUP BY DATE(viewed_at)
    ORDER BY date DESC
  `).all();

  return {
    totalPageViews: total.total,
    uniqueVisitors: uniqueVisitors.count,
    todayPageViews: today.count,
    todayUniqueVisitors: todayUnique.count,
    last7Days
  };
}

// Admin stats summary
export function getAdminStats() {
  const userStats = getUserStats();
  const downloadStats = getDownloadStats();
  const visitorStats = getVisitorStats();
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const todaySignups = db.prepare(`
    SELECT COUNT(*) as count FROM users
    WHERE DATE(created_at) = DATE('now')
  `).get();

  return {
    totalUsers: totalUsers.count,
    todaySignups: todaySignups.count,
    usersByTier: userStats,
    downloads: downloadStats,
    visitors: visitorStats
  };
}

export default db;
