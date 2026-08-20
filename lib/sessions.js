const crypto = require("crypto");
const db = require("./db");
const users = require("./users");

const SESSION_COOKIE = "dk_session";
/** Idle timeout — session expires after this much inactivity (sliding window on each request). */
const SESSION_MS = Number(process.env.SESSION_MS) || 2 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function cookieOptions(req) {
  const secure =
    process.env.COOKIE_SECURE === "1" ||
    process.env.NODE_ENV === "production" ||
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "").includes("https");
  return {
    httpOnly: true,
    secure: Boolean(secure),
    sameSite: "lax",
    maxAge: SESSION_MS,
    path: "/",
  };
}

function idleExpiresAt() {
  return new Date(Date.now() + SESSION_MS);
}

async function createSession(userId, req) {
  const token = newToken();
  const id = crypto.randomUUID();
  const expires = idleExpiresAt();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      id,
      userId,
      hashToken(token),
      expires,
      req.ip || null,
      String(req.headers["user-agent"] || "").slice(0, 512) || null,
    ]
  );
  return { token, expiresAt: expires };
}

async function touchSession(sessionId) {
  const expires = idleExpiresAt();
  const result = await db.query(`UPDATE sessions SET expires_at = ? WHERE id = ?`, [expires, sessionId]);
  if (!result.affectedRows) return null;
  return expires;
}

async function destroySession(token) {
  if (!token) return;
  await db.query("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}

async function destroyAllForUser(userId) {
  await db.query("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

async function resolveSession(token, { touch = false } = {}) {
  if (!token) return null;
  const rows = await db.query(
    `SELECT s.id AS session_id, s.user_id, s.expires_at, u.id, u.username, u.email, u.role,
            u.active, u.force_password_change, u.created_at, u.updated_at, u.last_login_at
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.active) return null;

  let expiresAt = row.expires_at;
  if (touch) {
    const touched = await touchSession(row.session_id);
    if (touched) expiresAt = touched;
  }

  return {
    sessionId: row.session_id,
    user: users.sanitize(row),
    expiresAt,
  };
}

async function cleanupExpired() {
  await db.query("DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()");
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MS,
  cookieOptions,
  createSession,
  touchSession,
  destroySession,
  destroyAllForUser,
  resolveSession,
  cleanupExpired,
  newToken,
};
