// ExodusXE Extension Popup - With Account Management

let upgradeUrl = '';

async function init() {
  // Get license and user info
  const [licenseData, userData] = await Promise.all([
    new Promise(resolve => chrome.runtime.sendMessage({ type: 'getLicense' }, resolve)),
    new Promise(resolve => chrome.runtime.sendMessage({ type: 'getUser' }, resolve))
  ]);

  updateAccountUI(userData?.user, licenseData?.license);

  // Get session info
  chrome.runtime.sendMessage({ type: 'getSession' }, (data) => {
    if (data?.roomId && data?.controllerUrl) {
      showConnected(data.roomId, data.controllerUrl, data.controllers);
    } else {
      chrome.runtime.sendMessage({ type: 'connect' });
      showLoading();
      setTimeout(init, 500);
    }
  });

  // Get upgrade URL
  chrome.runtime.sendMessage({ type: 'getUpgradeUrl' }, (data) => {
    upgradeUrl = data?.url || 'https://exodusxe-production.up.railway.app/upgrade';
  });
}

function updateAccountUI(user, license) {
  const accountSection = document.getElementById('accountSection');
  const signinSection = document.getElementById('signinSection');
  const trialBanner = document.getElementById('trialBanner');
  const upgradeBanner = document.getElementById('upgradeBanner');
  const signOutBtn = document.getElementById('signOutBtn');
  const tierBadge = document.getElementById('tierBadge');

  if (user) {
    // User is signed in
    accountSection.classList.remove('hidden');
    signinSection.classList.add('hidden');
    signOutBtn.classList.remove('hidden');

    // Update avatar
    const avatar = document.getElementById('accountAvatar');
    const avatarPlaceholder = document.getElementById('accountAvatarPlaceholder');
    if (user.picture) {
      avatar.src = user.picture;
      avatar.classList.remove('hidden');
      avatarPlaceholder.classList.add('hidden');
    } else {
      avatar.classList.add('hidden');
      avatarPlaceholder.classList.remove('hidden');
      avatarPlaceholder.textContent = (user.name || 'U')[0].toUpperCase();
    }

    // Update name and email
    document.getElementById('accountName').textContent = user.name || 'User';
    document.getElementById('accountEmail').textContent = user.email || '';
  } else {
    // User is not signed in
    accountSection.classList.add('hidden');
    signinSection.classList.remove('hidden');
    signOutBtn.classList.add('hidden');
  }

  // Update license display
  if (license) {
    const tier = license.tier;

    // Update tier badge
    tierBadge.textContent = tier.toUpperCase();
    tierBadge.className = 'tier-badge ' + tier;

    // Show/hide trial banner
    if (tier === 'trial' && license.daysRemaining !== undefined) {
      trialBanner.classList.remove('hidden');
      document.getElementById('trialDays').textContent = license.daysRemaining;
      const progress = (license.daysRemaining / 7) * 100;
      document.getElementById('trialProgressBar').style.width = progress + '%';
    } else {
      trialBanner.classList.add('hidden');
    }

    // Show upgrade banner for free and trial users (not pro/lifetime)
    if (tier === 'free' || tier === 'trial') {
      upgradeBanner.classList.remove('hidden');
    } else {
      upgradeBanner.classList.add('hidden');
    }
  }
}

function showLoading() {
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('main').style.display = 'none';
}

function showConnected(roomId, controllerUrl, controllers) {
  document.getElementById('qrCode').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(controllerUrl)}&bgcolor=0a0a0a&color=00ff88`;
  document.getElementById('roomCode').textContent = roomId;

  const connected = controllers > 0;
  document.getElementById('statusDot').classList.toggle('connected', connected);
  document.getElementById('statusText').textContent = connected ? 'Phone connected' : 'Scan to connect';

  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';
}

function newSession() {
  chrome.runtime.sendMessage({ type: 'newSession' });
  showLoading();
  setTimeout(init, 500);
}

async function signInWithGoogle() {
  const btn = document.getElementById('googleSignInBtn');
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'signIn' }, (response) => {
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Sign in with Google`;
    btn.disabled = false;

    if (response?.success) {
      updateAccountUI(response.user, response.license);
    } else {
      console.error('Sign in failed:', response?.error);
    }
  });
}

function signOut() {
  chrome.runtime.sendMessage({ type: 'signOut' }, (response) => {
    if (response?.success) {
      init(); // Refresh UI
    }
  });
}

function openUpgrade() {
  if (upgradeUrl) {
    chrome.tabs.create({ url: upgradeUrl });
  }
}

// Listen for storage changes (connection status updates)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.controllers) {
    const connected = changes.controllers.newValue > 0;
    document.getElementById('statusDot').classList.toggle('connected', connected);
    document.getElementById('statusText').textContent = connected ? 'Phone connected' : 'Scan to connect';
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('newSessionBtn').addEventListener('click', newSession);
  document.getElementById('googleSignInBtn').addEventListener('click', signInWithGoogle);
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('upgradeBanner').addEventListener('click', openUpgrade);

  init();

  // Don't auto-close popup when user is interacting
  // setTimeout(() => { window.close(); }, 10000);
});
