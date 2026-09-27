// db.js — SQLite data layer for LocalChat
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'localchat.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId        TEXT PRIMARY KEY,
    email         TEXT,
    passwordHash  TEXT,
    name          TEXT NOT NULL,
    avatar        TEXT DEFAULT '👤',
    lat           REAL,
    lng           REAL,
    platforms     TEXT DEFAULT '[]',
    socialHandles TEXT DEFAULT '{}',
    lastSeen      TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users(LOWER(email))
    WHERE email IS NOT NULL;

  CREATE TABLE IF NOT EXISTS invites (
    inviteId   TEXT PRIMARY KEY,
    fromUserId TEXT NOT NULL,
    toUserId   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    createdAt  TEXT NOT NULL,
    FOREIGN KEY (fromUserId) REFERENCES users(userId) ON DELETE CASCADE,
    FOREIGN KEY (toUserId)   REFERENCES users(userId) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_invites_to   ON invites(toUserId, status);
  CREATE INDEX IF NOT EXISTS idx_invites_from ON invites(fromUserId);

  CREATE TABLE IF NOT EXISTS friendships (
    userId   TEXT NOT NULL,
    friendId TEXT NOT NULL,
    PRIMARY KEY (userId, friendId),
    FOREIGN KEY (userId)   REFERENCES users(userId) ON DELETE CASCADE,
    FOREIGN KEY (friendId) REFERENCES users(userId) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    roomId     TEXT NOT NULL,
    fromUserId TEXT NOT NULL,
    text       TEXT NOT NULL,
    createdAt  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(roomId, createdAt);
`);

const parseUser = (row) => {
  if (!row) return null;
  const { passwordHash, ...safe } = row;
  return {
    ...safe,
    platforms:     JSON.parse(row.platforms || '[]'),
    socialHandles: JSON.parse(row.socialHandles || '{}'),
    lat: row.lat != null ? row.lat : null,
    lng: row.lng != null ? row.lng : null,
  };
};

const users = {
  upsert(user) {
    const stmt = db.prepare(`
      INSERT INTO users (userId, name, avatar, lat, lng, platforms, socialHandles, lastSeen)
      VALUES (@userId, @name, @avatar, @lat, @lng, @platforms, @socialHandles, @lastSeen)
      ON CONFLICT(userId) DO UPDATE SET
        name          = excluded.name,
        avatar        = excluded.avatar,
        lat           = excluded.lat,
        lng           = excluded.lng,
        platforms     = excluded.platforms,
        socialHandles = excluded.socialHandles,
        lastSeen      = excluded.lastSeen
    `);
    stmt.run({
      userId: user.userId,
      name: user.name,
      avatar: user.avatar || '👤',
      lat: user.lat ?? null,
      lng: user.lng ?? null,
      platforms: JSON.stringify(user.platforms || []),
      socialHandles: JSON.stringify(user.socialHandles || {}),
      lastSeen: new Date().toISOString(),
    });
    return users.get(user.userId);
  },

  get(userId) {
    return parseUser(db.prepare('SELECT * FROM users WHERE userId = ?').get(userId));
  },

  all() {
    return db.prepare('SELECT * FROM users').all().map(parseUser);
  },

  findByEmail(email) {
    if (!email) return null;
    return parseUser(
      db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email)
    );
  },

  createAccount({ userId, email, passwordHash, name, avatar }) {
    db.prepare(`
      INSERT INTO users (userId, email, passwordHash, name, avatar, platforms, socialHandles, lastSeen)
      VALUES (?, ?, ?, ?, ?, '[]', '{}', ?)
    `).run(userId, email, passwordHash, name, avatar || '👤', new Date().toISOString());
    return users.get(userId);
  },

  updateProfile(userId, { name, avatar, platforms, socialHandles }) {
    db.prepare(`
      UPDATE users
      SET name = ?, avatar = ?, platforms = ?, socialHandles = ?, lastSeen = ?
      WHERE userId = ?
    `).run(
      name,
      avatar || '👤',
      JSON.stringify(platforms || []),
      JSON.stringify(socialHandles || {}),
      new Date().toISOString(),
      userId
    );
    return users.get(userId);
  },

  updateLocation(userId, lat, lng) {
    db.prepare('UPDATE users SET lat = ?, lng = ?, lastSeen = ? WHERE userId = ?')
      .run(lat, lng, new Date().toISOString(), userId);
    return users.get(userId);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  },
};

const invites = {
  create(invite) {
    db.prepare(`
      INSERT INTO invites (inviteId, fromUserId, toUserId, status, createdAt)
      VALUES (@inviteId, @fromUserId, @toUserId, @status, @createdAt)
    `).run(invite);
    return invite;
  },
  get(inviteId) {
    return db.prepare('SELECT * FROM invites WHERE inviteId = ?').get(inviteId);
  },
  setStatus(inviteId, status) {
    db.prepare('UPDATE invites SET status = ? WHERE inviteId = ?').run(status, inviteId);
    return invites.get(inviteId);
  },
  pendingFor(userId) {
    return db.prepare(`
      SELECT * FROM invites WHERE toUserId = ? AND status = 'pending'
      ORDER BY createdAt DESC
    `).all(userId);
  },
};

const friendships = {
  add(a, b) {
    const stmt = db.prepare('INSERT OR IGNORE INTO friendships (userId, friendId) VALUES (?, ?)');
    stmt.run(a, b);
    stmt.run(b, a);
  },
  of(userId) {
    return db.prepare('SELECT friendId FROM friendships WHERE userId = ?')
      .all(userId).map(r => r.friendId);
  },
};

const messages = {
  add(msg) {
    db.prepare(`
      INSERT INTO messages (id, roomId, fromUserId, text, createdAt)
      VALUES (@id, @roomId, @fromUserId, @text, @createdAt)
    `).run(msg);
    return msg;
  },
  forRoom(roomId, limit = 200) {
    return db.prepare(`
      SELECT * FROM messages WHERE roomId = ?
      ORDER BY createdAt ASC LIMIT ?
    `).all(roomId, limit);
  },
};

module.exports = { db, users, invites, friendships, messages };

