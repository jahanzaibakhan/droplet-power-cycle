const sessions = require("../lib/sessions");

function getToken(req) {
  return req.cookies && req.cookies[sessions.SESSION_COOKIE];
}

async function attachUser(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) {
      req.user = null;
      return next();
    }
    const resolved = await sessions.resolveSession(token, { touch: true });
    if (!resolved) {
      req.user = null;
      return next();
    }
    req.user = resolved.user;
    req.sessionId = resolved.sessionId;
    req.sessionExpiresAt = resolved.expiresAt;
    res.cookie(sessions.SESSION_COOKIE, token, sessions.cookieOptions(req));
    res.setHeader("X-Session-Expires", new Date(resolved.expiresAt).toISOString());
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

function clientIp(req) {
  return (
    String(req.headers["cf-connecting-ip"] || "").trim() ||
    String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() ||
    req.ip ||
    null
  );
}

module.exports = { attachUser, requireAuth, requireAdmin, clientIp, getToken };
