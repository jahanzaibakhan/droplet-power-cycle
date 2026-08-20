const express = require("express");
const users = require("../lib/users");
const sessions = require("../lib/sessions");
const activityLog = require("../lib/activityLog");
const { requireAuth, clientIp } = require("../middleware/auth");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || "").trim();
    const password = String((req.body && req.body.password) || "");
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const row = await users.findByUsername(username);
    const ip = clientIp(req);

    if (!row || !row.active) {
      activityLog
        .append({
          username,
          category: "auth",
          action: "login_failed",
          detail: "Invalid credentials or inactive account",
          ip,
        })
        .catch(() => {});
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const ok = await users.verifyPassword(password, row.password_hash);
    if (!ok) {
      activityLog
        .append({
          userId: row.id,
          username: row.username,
          category: "auth",
          action: "login_failed",
          detail: "Wrong password",
          ip,
        })
        .catch(() => {});
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const { token, expiresAt } = await sessions.createSession(row.id, req);
    await users.recordLogin(row.id);
    activityLog
      .append({
        userId: row.id,
        username: row.username,
        category: "auth",
        action: "login",
        ip,
      })
      .catch(() => {});

    res.cookie(sessions.SESSION_COOKIE, token, sessions.cookieOptions(req));
    res.setHeader("X-Session-Expires", new Date(expiresAt).toISOString());
    res.json({ user: users.sanitize(row), session_expires_at: expiresAt });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const token = req.cookies && req.cookies[sessions.SESSION_COOKIE];
    await sessions.destroySession(token);
    await activityLog.append({
      userId: req.user.id,
      username: req.user.username,
      category: "auth",
      action: "logout",
      ip: clientIp(req),
    });
    res.clearCookie(sessions.SESSION_COOKIE, { ...sessions.cookieOptions(req), maxAge: 0 });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    user: req.user,
    session_expires_at: req.sessionExpiresAt || null,
  });
});

module.exports = router;
