require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { users, invites, friendships, messages } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken, requireAuth } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const sessions = new Map();

// ==================== HELPERS ====================
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const findSocketForUser = (userId) => {
  for (const [sid, uid] of sessions.entries()) if (uid === userId) return sid;
  return null;
};

// ==================== AUTH ROUTES ====================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, avatar } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (users.findByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

    const userId = 'u_' + uuidv4().slice(0, 8);
    const passwordHash = await hashPassword(password);
    const user = users.createAccount({
      userId, email, passwordHash,
      name: (name || email.split('@')[0]).slice(0, 24),
      avatar: avatar || '🙂',
    });

    const token = signToken({ userId });
    res.json({ success: true, token, user });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const row = users.findByEmail(email);
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });

    const raw = require('./db').db
      .prepare('SELECT passwordHash FROM users WHERE userId = ?')
      .get(row.userId);

    const ok = await verifyPassword(password, raw.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ userId: row.userId });
    res.json({ success: true, token, user: row });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = users.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ==================== USER ROUTES ====================

app.post('/api/user', requireAuth, (req, res) => {
  const { name, avatar, lat, lng, platforms, socialHandles } = req.body;
  const userId = req.userId;

  const existing = users.get(userId);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  users.updateProfile(userId, {
    name: name || existing.name,
    avatar: avatar || existing.avatar,
    platforms: platforms ?? existing.platforms,
    socialHandles: socialHandles ?? existing.socialHandles,
  });

  if (lat != null && lng != null) users.updateLocation(userId, lat, lng);

  const finalUser = users.get(userId);
  io.emit('user:updated', { userId, name: finalUser.name });
  res.json({ success: true, user: finalUser });
});

app.get('/api/nearby', requireAuth, (req, res) => {
  const { lat, lng, radiusKm = 5 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  const meId = req.userId;
  const uLat = parseFloat(lat), uLng = parseFloat(lng), radius = parseFloat(radiusKm);

  const results = [];
  for (const user of users.all()) {
    if (user.userId === meId) continue;
    if (user.lat == null || user.lng == null) continue;
    const dist = haversineDistance(uLat, uLng, user.lat, user.lng);
    if (dist <= radius) {
      results.push({
        userId: user.userId,
        name: user.name,
        avatar: user.avatar,
        platforms: user.platforms,
        socialHandles: user.socialHandles,
        distanceKm: parseFloat(dist.toFixed(2)),
      });
    }
  }
  results.sort((a, b) => a.distanceKm - b.distanceKm);
  res.json({ users: results, count: results.length });
});

app.post('/api/invite', requireAuth, (req, res) => {
  const fromUserId = req.userId;
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  if (toUserId === fromUserId) return res.status(400).json({ error: 'Cannot invite yourself' });

  const from = users.get(fromUserId);
  const to = users.get(toUserId);
  if (!from || !to) return res.status(404).json({ error: 'User not found' });

  const invite = {
    inviteId: uuidv4(),
    fromUserId,
    toUserId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  invites.create(invite);

  const recipientSocketId = findSocketForUser(toUserId);
  if (recipientSocketId) {
    io.to(recipientSocketId).emit('invite:received', {
      inviteId: invite.inviteId,
      from: { userId: from.userId, name: from.name, avatar: from.avatar },
    });
  }

  res.json({ success: true, invite });
});

app.post('/api/invite/accept', requireAuth, (req, res) => {
  const { inviteId } = req.body;
  const userId = req.userId;
  const invite = invites.get(inviteId);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.toUserId !== userId) return res.status(403).json({ error: 'Not your invite' });

  invites.setStatus(inviteId, 'accepted');
  const roomId = [invite.fromUserId, invite.toUserId].sort().join('__');
  friendships.add(invite.fromUserId, invite.toUserId);

  io.to(roomId).emit('chat:ready', { roomId });
  [invite.fromUserId, invite.toUserId].forEach(uid => {
    const sid = findSocketForUser(uid);
    if (sid) {
      io.to(sid).emit('chat:ready', {
        roomId,
        withUserId: uid === invite.fromUserId ? invite.toUserId : invite.fromUserId,
      });
    }
  });

  res.json({ success: true, roomId });
});

app.post('/api/invite/reject', requireAuth, (req, res) => {
  const { inviteId } = req.body;
  const userId = req.userId;
  const invite = invites.get(inviteId);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.toUserId !== userId) return res.status(403).json({ error: 'Not your invite' });

  invites.setStatus(inviteId, 'rejected');
  io.emit('invite:rejected', { inviteId });
  res.json({ success: true });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const friendIds = friendships.of(req.userId);
  const friends = friendIds.map(uid => {
    const u = users.get(uid);
    return u ? { userId: u.userId, name: u.name, avatar: u.avatar } : null;
  }).filter(Boolean);
  res.json({ friends });
});

app.get('/api/invites/pending', requireAuth, (req, res) => {
  const pending = invites.pendingFor(req.userId).map(inv => {
    const from = users.get(inv.fromUserId) || { name: 'Unknown', avatar: '👤' };
    return {
      inviteId: inv.inviteId,
      fromUserId: inv.fromUserId,
      from: { userId: from.userId, name: from.name, avatar: from.avatar },
      createdAt: inv.createdAt,
    };
  });
  res.json({ invites: pending });
});

app.get('/api/chat/:roomId/messages', requireAuth, (req, res) => {
  const { roomId } = req.params;
  const member = roomId.split('__').includes(req.userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this room' });
  res.json({ messages: messages.forRoom(roomId) });
});

// ==================== SOCKET.IO ====================
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Missing auth token'));
  const payload = verifyToken(token);
  if (!payload) return next(new Error('Invalid token'));
  socket.userId = payload.userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  sessions.set(socket.id, userId);
  socket.join(`user:${userId}`);
  console.log(`🔌 ${userId} connected (${socket.id})`);

  socket.on('chat:join', ({ roomId }) => {
    if (!roomId || !roomId.split('__').includes(userId)) {
      return socket.emit('error', { message: 'Not a member of this room' });
    }
    socket.join(roomId);
    socket.emit('chat:joined', { roomId });
  });

  socket.on('chat:message', ({ roomId, text }) => {
    if (!roomId || !text?.trim()) return;
    if (!roomId.split('__').includes(userId)) return;

    const message = {
      id: uuidv4(),
      roomId,
      fromUserId: userId,
      text: text.trim().slice(0, 2000),
      createdAt: new Date().toISOString(),
    };
    messages.add(message);
    io.to(roomId).emit('chat:message', message);
  });

  socket.on('chat:typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('chat:typing', { userId, isTyping: !!isTyping });
  });

  socket.on('location:update', ({ lat, lng }) => {
    if (lat == null || lng == null) return;
    users.updateLocation(userId, lat, lng);
    io.emit('location:updated', { userId });
  });

  socket.on('disconnect', () => {
    sessions.delete(socket.id);
    io.emit('user:offline', { userId });
    console.log(`❌ ${userId} disconnected`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 LocalChat backend running on http://localhost:${PORT}`);
  console.log(`🔐 JWT auth enabled`);
  console.log(`🌐 Frontend: http://localhost:${PORT}/index.html`);
});
