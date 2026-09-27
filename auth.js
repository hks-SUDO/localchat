// auth.js — password hashing and JWT helpers
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ⚠️ In production, load this from process.env.JWT_SECRET
// Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET not set — using insecure default. Set it in .env!');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production-please';
const JWT_EXPIRES_IN = '30d';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware — requires Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  req.userId = payload.userId;
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth };
