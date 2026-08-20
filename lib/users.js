const bcrypt = require("bcryptjs");
const db = require("./db");

const BCRYPT_ROUNDS = 12;
const USER_FIELDS =
  "id, username, email, role, active, force_password_change, created_at, updated_at, last_login_at";

function sanitize(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    active: Boolean(row.active),
    force_password_change: Boolean(row.force_password_change),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(String(password), hash);
}

async function findById(id) {
  const rows = await db.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ? LIMIT 1`, [id]);
  return sanitize(rows[0]);
}

async function findByUsername(username) {
  const rows = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [
    String(username || "").trim().toLowerCase(),
  ]);
  return rows[0] || null;
}

async function findByEmail(email) {
  const rows = await db.query(`SELECT * FROM users WHERE email = ? LIMIT 1`, [
    String(email || "").trim().toLowerCase(),
  ]);
  return rows[0] || null;
}

async function listUsers() {
  const rows = await db.query(
    `SELECT ${USER_FIELDS} FROM users ORDER BY role DESC, username ASC`
  );
  return rows.map(sanitize);
}

async function countAdmins(excludeId) {
  const params = [];
  let sql = "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1";
  if (excludeId) {
    sql += " AND id != ?";
    params.push(excludeId);
  }
  const rows = await db.query(sql, params);
  return Number(rows[0].c) || 0;
}

async function createUser({ username, email, password, role = "user", forcePasswordChange = false }) {
  const u = String(username || "").trim().toLowerCase();
  const e = String(email || "").trim().toLowerCase();
  if (!u || u.length < 2) {
    const error = new Error("Username must be at least 2 characters.");
    error.status = 400;
    throw error;
  }
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    const error = new Error("A valid email is required.");
    error.status = 400;
    throw error;
  }
  if (!password || String(password).length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.status = 400;
    throw error;
  }
  const r = role === "admin" ? "admin" : "user";
  const hash = await hashPassword(password);
  const result = await db.query(
    `INSERT INTO users (username, email, password_hash, role, force_password_change)
     VALUES (?, ?, ?, ?, ?)`,
    [u, e, hash, r, forcePasswordChange ? 1 : 0]
  );
  return findById(result.insertId);
}

async function updateUser(id, fields) {
  const current = await findById(id);
  if (!current) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }

  const sets = [];
  const params = [];

  if (fields.username != null) {
    const u = String(fields.username).trim().toLowerCase();
    if (u.length < 2) {
      const error = new Error("Username must be at least 2 characters.");
      error.status = 400;
      throw error;
    }
    sets.push("username = ?");
    params.push(u);
  }
  if (fields.email != null) {
    const e = String(fields.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      const error = new Error("A valid email is required.");
      error.status = 400;
      throw error;
    }
    sets.push("email = ?");
    params.push(e);
  }
  if (fields.role != null) {
    if (fields.role === "admin" && current.role !== "admin") {
      sets.push("role = 'admin'");
    } else if (fields.role === "user" && current.role === "admin") {
      const admins = await countAdmins(id);
      if (admins < 1) {
        const error = new Error("Cannot demote the last active admin.");
        error.status = 400;
        throw error;
      }
      sets.push("role = 'user'");
    }
  }
  if (fields.active != null) {
    if (!fields.active && current.role === "admin") {
      const admins = await countAdmins(id);
      if (admins < 1) {
        const error = new Error("Cannot disable the last active admin.");
        error.status = 400;
        throw error;
      }
    }
    sets.push("active = ?");
    params.push(fields.active ? 1 : 0);
  }
  if (fields.force_password_change != null) {
    sets.push("force_password_change = ?");
    params.push(fields.force_password_change ? 1 : 0);
  }

  if (!sets.length) return current;

  params.push(id);
  await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
}

async function setPassword(id, password, { clearForce = true } = {}) {
  if (!password || String(password).length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.status = 400;
    throw error;
  }
  const hash = await hashPassword(password);
  await db.query(
    `UPDATE users SET password_hash = ?, force_password_change = ? WHERE id = ?`,
    [hash, clearForce ? 0 : 1, id]
  );
}

async function recordLogin(id) {
  await db.query("UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
}

async function countUsers() {
  const rows = await db.query("SELECT COUNT(*) AS c FROM users");
  return Number(rows[0].c) || 0;
}

module.exports = {
  sanitize,
  hashPassword,
  verifyPassword,
  findById,
  findByUsername,
  findByEmail,
  listUsers,
  createUser,
  updateUser,
  setPassword,
  recordLogin,
  countUsers,
  countAdmins,
};
