const crypto = require("crypto");
const db = require("./db");
const users = require("./users");

const SESSION_COOKIE = "dk_session";
const SESSION_MS = Number(process.env.SESSION_MS) || 24 * 60 * 60 * 1000;

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

async function createSession(userId, req) {
  const token = newToken();
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_MS);
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      hashToken(token),
      expires,
      req.ip || null,
      String(req.headers["user-agent"] || "").slice(0, 512) || null,
    ]
  );
  return token;
}

async function destroySession(token) {
  if (!token) return;
  await db.query("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}

async function destroyAllForUser(userId) {
  await db.query("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

async function resolveSession(token) {
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
  return {
    sessionId: row.session_id,
    user: users.sanitize(row),
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
  destroySession,
  destroyAllForUser,
  resolveSession,
  cleanupExpired,
  newToken,
};
