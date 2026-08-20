const express = require("express");
const users = require("../lib/users");
const sessions = require("../lib/sessions");
const activityLog = require("../lib/activityLog");
const { requireAdmin, clientIp } = require("../middleware/auth");

const router = express.Router();

router.use(requireAdmin);

router.get("/users", async (_req, res, next) => {
  try {
    const list = await users.listUsers();
    res.json({ users: list });
  } catch (err) {
    next(err);
  }
});

router.post("/users", async (req, res, next) => {
  try {
    const body = req.body || {};
    const created = await users.createUser({
      username: body.username,
      email: body.email,
      password: body.password,
      role: body.role === "admin" ? "admin" : "user",
      forcePasswordChange: Boolean(body.force_password_change),
    });

    await activityLog.append({
      userId: req.user.id,
      username: req.user.username,
      category: "admin",
      action: "user_created",
      detail: `Created ${created.username} (${created.role})`,
      ip: clientIp(req),
    });

    res.status(201).json({ user: created });
  } catch (err) {
    next(err);
  }
});

router.put("/users/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const before = await users.findById(id);
    if (!before) return res.status(404).json({ error: "User not found." });

    const updates = {};
    if (body.username != null) updates.username = body.username;
    if (body.email != null) updates.email = body.email;
    if (body.role != null) updates.role = body.role;
    if (body.active != null) updates.active = Boolean(body.active);
    if (body.force_password_change != null) {
      updates.force_password_change = Boolean(body.force_password_change);
    }

    const updated = await users.updateUser(id, updates);

    const parts = [];
    if (updates.username && updates.username !== before.username) {
      parts.push(`username → ${updated.username}`);
    }
    if (updates.email && updates.email !== before.email) {
      parts.push(`email → ${updated.email}`);
    }
    if (updates.role && updates.role !== before.role) {
      parts.push(`role → ${updated.role}`);
    }
    if (updates.active != null && updates.active !== before.active) {
      parts.push(updated.active ? "enabled" : "disabled");
    }

    await activityLog.append({
      userId: req.user.id,
      username: req.user.username,
      category: "admin",
      action: "user_updated",
      detail: `${before.username}: ${parts.join(", ") || "updated"}`,
      ip: clientIp(req),
    });

    if (updates.active === false) {
      await sessions.destroyAllForUser(id);
    }

    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

router.put("/users/:id/password", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const password = String((req.body && req.body.password) || "");
    const target = await users.findById(id);
    if (!target) return res.status(404).json({ error: "User not found." });

    const force = Boolean(req.body && req.body.force_password_change);
    await users.setPassword(id, password, { clearForce: !force });
    await sessions.destroyAllForUser(id);

    await activityLog.append({
      userId: req.user.id,
      username: req.user.username,
      category: "admin",
      action: "password_reset",
      detail: `Reset password for ${target.username}`,
      ip: clientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/activity", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const userId = req.query.user_id ? Number(req.query.user_id) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;
    const logs = await activityLog.list({ limit, userId, category });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
