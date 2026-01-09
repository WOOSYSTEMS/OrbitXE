import jwt from 'jsonwebtoken';
import {
  createUser,
  getUserByGoogleId,
  getLicenseForUser,
  FEATURES
} from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'orbitxe-dev-secret';
const JWT_EXPIRY = '7d';

// Decode JWT ID token payload (for Google Identity Services)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// Verify Google OAuth token - supports both access tokens and ID tokens
export async function verifyGoogleToken(token) {
  try {
    // Check if it's a JWT ID token (from Google Identity Services on web)
    const jwtPayload = decodeJwtPayload(token);
    if (jwtPayload && jwtPayload.iss && jwtPayload.iss.includes('accounts.google.com')) {
      // Verify ID token with Google
      const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
      if (!response.ok) {
        throw new Error('Invalid ID token');
      }
      const data = await response.json();
      return {
        googleId: data.sub,
        email: data.email,
        name: data.name,
        picture: data.picture
      };
    }

    // Otherwise treat as access token (from Chrome extension)
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);

    if (!response.ok) {
      throw new Error('Invalid Google token');
    }

    const data = await response.json();

    // Get user profile
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!profileResponse.ok) {
      throw new Error('Could not fetch user profile');
    }

    const profile = await profileResponse.json();

    return {
      googleId: profile.id,
      email: profile.email,
      name: profile.name,
      picture: profile.picture
    };
  } catch (error) {
    console.error('Google token verification error:', error);
    throw new Error('Invalid Google token');
  }
}

// Authenticate user with Google token
export async function authenticateWithGoogle(googleToken) {
  const googleUser = await verifyGoogleToken(googleToken);

  // Check if user exists
  let user = getUserByGoogleId(googleUser.googleId);

  if (!user) {
    // Create new user with trial
    user = createUser({
      email: googleUser.email,
      googleId: googleUser.googleId,
      name: googleUser.name,
      pictureUrl: googleUser.picture
    });
  }

  // Generate JWT
  const token = generateToken(user);

  // Get license info
  const license = getLicenseForUser(user);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture_url
    },
    license,
    token
  };
}

// Generate JWT token
export function generateToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

// Verify JWT token
export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    return null;
  }
}

// Middleware to authenticate requests
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.userId = decoded.userId;
  req.userEmail = decoded.email;
  next();
}

export { FEATURES };
