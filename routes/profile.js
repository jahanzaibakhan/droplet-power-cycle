const express = require("express");
const users = require("../lib/users");
const sessions = require("../lib/sessions");
const activityLog = require("../lib/activityLog");
const { requireAuth, clientIp } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    res.json({ user: req.user });
  } catch (err) {
    next(err);
  }
});

router.put("/password", async (req, res, next) => {
  try {
    const current = String((req.body && req.body.current_password) || "");
    const nextPass = String((req.body && req.body.new_password) || "");
    if (!current || !nextPass) {
      return res.status(400).json({ error: "Current and new password are required." });
    }

    const row = await users.findAuthById(req.user.id);
    if (!row) {
      return res.status(401).json({ error: "Authentication required." });
    }
    const ok = await users.verifyPassword(current, row.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    await users.setPassword(req.user.id, nextPass);
    await sessions.destroyAllForUser(req.user.id);
    const { token, expiresAt } = await sessions.createSession(req.user.id, req);
    res.cookie(sessions.SESSION_COOKIE, token, sessions.cookieOptions(req));
    res.setHeader("X-Session-Expires", new Date(expiresAt).toISOString());

    await activityLog.append({
      userId: req.user.id,
      username: req.user.username,
      category: "auth",
      action: "password_changed",
      detail: "Self password change",
      ip: clientIp(req),
    });

    res.json({ ok: true, message: "Password updated.", user: await users.findById(req.user.id), session_expires_at: expiresAt });
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = {};
    if (body.email != null) updates.email = body.email;
    if (body.username != null) updates.username = body.username;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    const before = await users.findById(req.user.id);
    const updated = await users.updateUser(req.user.id, updates);

    const parts = [];
    if (updates.username && updates.username !== before.username) {
      parts.push(`username: ${before.username} → ${updated.username}`);
    }
    if (updates.email && updates.email !== before.email) {
      parts.push(`email: ${before.email} → ${updated.email}`);
    }

    await activityLog.append({
      userId: req.user.id,
      username: updated.username,
      category: "auth",
      action: "profile_updated",
      detail: parts.join("; ") || "Profile updated",
      ip: clientIp(req),
    });

    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
