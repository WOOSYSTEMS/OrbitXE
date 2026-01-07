// OrbitXE License Module
// Handles authentication, trial tracking, and feature gating

// Production URL
const SERVER_URL = 'https://orbitxe.com';
const TRIAL_DURATION_DAYS = 7;

// Feature definitions (must match server/db.js)
const FEATURES = {
  FREE: ['trackpad', 'scroll_buttons'],
  TRIAL: ['trackpad', 'scroll_buttons', 'keyboard', 'tab_switch', 'open_tab',
          'youtube', 'netflix', 'slides', 'zoom', 'meet', 'two_finger_scroll'],
  PRO: ['trackpad', 'scroll_buttons', 'keyboard', 'tab_switch', 'open_tab',
        'youtube', 'netflix', 'slides', 'zoom', 'meet', 'two_finger_scroll']
};

// Get current license status
export async function getLicense() {
  try {
    const data = await chrome.storage.local.get(['authToken', 'license', 'firstInstallDate']);

    // If authenticated, validate with server
    if (data.authToken) {
      const serverLicense = await validateWithServer(data.authToken);
      if (serverLicense) {
        await chrome.storage.local.set({ license: serverLicense });
        return serverLicense;
      }
      // Token invalid, clear auth
      await chrome.storage.local.remove(['authToken', 'user', 'license']);
    }

    // Not authenticated - check local trial
    return getLocalTrialStatus(data.firstInstallDate);
  } catch (error) {
    console.error('OrbitXE License: Error getting license:', error);
    // Fallback to local trial check
    const data = await chrome.storage.local.get(['firstInstallDate']);
    return getLocalTrialStatus(data.firstInstallDate);
  }
}

// Check local trial status (for users who haven't signed in)
async function getLocalTrialStatus(firstInstallDate) {
  if (!firstInstallDate) {
    // First install - start trial
    const now = new Date().toISOString();
    const trialEnds = new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await chrome.storage.local.set({
      firstInstallDate: now,
      trialEndsAt: trialEnds
    });
    return {
      tier: 'trial',
      features: FEATURES.TRIAL,
      trialEndsAt: trialEnds,
      daysRemaining: TRIAL_DURATION_DAYS,
      isLocal: true
    };
  }

  // Check if trial is still active
  const data = await chrome.storage.local.get(['trialEndsAt']);
  const trialEnds = new Date(data.trialEndsAt || firstInstallDate);
  const now = Date.now();

  // If trial hasn't ended yet (for old installs without trialEndsAt)
  if (!data.trialEndsAt) {
    const installDate = new Date(firstInstallDate);
    const trialEnd = new Date(installDate.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
    await chrome.storage.local.set({ trialEndsAt: trialEnd.toISOString() });

    if (now < trialEnd.getTime()) {
      const daysRemaining = Math.ceil((trialEnd.getTime() - now) / (24 * 60 * 60 * 1000));
      return {
        tier: 'trial',
        features: FEATURES.TRIAL,
        trialEndsAt: trialEnd.toISOString(),
        daysRemaining,
        isLocal: true
      };
    }
  }

  if (now < trialEnds.getTime()) {
    const daysRemaining = Math.ceil((trialEnds.getTime() - now) / (24 * 60 * 60 * 1000));
    return {
      tier: 'trial',
      features: FEATURES.TRIAL,
      trialEndsAt: trialEnds.toISOString(),
      daysRemaining,
      isLocal: true
    };
  }

  // Trial expired
  return {
    tier: 'free',
    features: FEATURES.FREE,
    trialExpired: true,
    isLocal: true
  };
}

// Validate token with server
async function validateWithServer(token) {
  try {
    const response = await fetch(`${SERVER_URL}/api/auth/validate`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.license;
  } catch (error) {
    console.error('OrbitXE License: Server validation failed:', error);
    return null;
  }
}

// Check if user has access to a specific feature
export async function hasFeature(feature) {
  const license = await getLicense();
  return license.features.includes(feature);
}

// Map message types to required features
const FEATURE_MAP = {
  'keyboard': 'keyboard',
  'switchTab': 'tab_switch',
  'openTab': 'open_tab',
  'youtube': 'youtube',
  'netflix': 'netflix',
  'slides': 'slides',
  'zoom': 'zoom',
  'meet': 'meet'
};

// Check if a message action is allowed
export async function isActionAllowed(msgType, action) {
  // Always allow basic actions
  if (['mouse', 'scroll', 'ping', 'pong', 'join', 'status', 'joined', 'getTabs', 'activeTab', 'tabList'].includes(msgType)) {
    return { allowed: true };
  }

  // Check feature requirements
  const requiredFeature = FEATURE_MAP[msgType];
  if (requiredFeature) {
    const allowed = await hasFeature(requiredFeature);
    return { allowed, requiredFeature };
  }

  // For action messages, check the specific action
  if (msgType === 'action') {
    // Site-specific actions require their feature
    const siteActions = ['youtube', 'netflix', 'slides', 'zoom', 'meet'];
    for (const site of siteActions) {
      if (action && action.toLowerCase().includes(site)) {
        const allowed = await hasFeature(site);
        return { allowed, requiredFeature: site };
      }
    }
  }

  // Default allow
  return { allowed: true };
}

// Sign in with Google
export async function signInWithGoogle() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!token) {
        reject(new Error('No token received'));
        return;
      }

      try {
        // Exchange Google token for our JWT
        const response = await fetch(`${SERVER_URL}/api/auth/google`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ token })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Authentication failed');
        }

        const data = await response.json();

        // Store auth data
        await chrome.storage.local.set({
          authToken: data.token,
          user: data.user,
          license: data.license
        });

        resolve(data);
      } catch (error) {
        // Revoke the Google token on error
        chrome.identity.removeCachedAuthToken({ token });
        reject(error);
      }
    });
  });
}

// Sign out
export async function signOut() {
  const data = await chrome.storage.local.get(['authToken']);

  // Clear stored auth data (keep firstInstallDate for local trial tracking)
  await chrome.storage.local.remove(['authToken', 'user', 'license']);

  // Revoke Google token
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// Get current user info
export async function getCurrentUser() {
  const data = await chrome.storage.local.get(['user', 'authToken']);
  if (data.authToken && data.user) {
    return data.user;
  }
  return null;
}

// Get upgrade URL with auth token
export async function getUpgradeUrl() {
  const data = await chrome.storage.local.get(['authToken']);
  if (data.authToken) {
    return `${SERVER_URL}/upgrade?token=${encodeURIComponent(data.authToken)}`;
  }
  return `${SERVER_URL}/upgrade`;
}

// Export constants
export { FEATURES, SERVER_URL };
