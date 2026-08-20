const crypto = require("crypto");
const db = require("./db");

async function append({ userId, username, category, action, detail, ip }) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO activity_logs (id, user_id, username, category, action, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId || null,
      username || null,
      category,
      action,
      detail ? String(detail).slice(0, 4000) : null,
      ip || null,
    ]
  );
  return id;
}

async function list({ limit = 100, userId, category } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const params = [];
  let sql = `SELECT id, user_id, username, category, action, detail, ip, created_at
             FROM activity_logs WHERE 1=1`;

  if (userId) {
    sql += " AND user_id = ?";
    params.push(Number(userId));
  }
  if (category) {
    sql += " AND category = ?";
    params.push(String(category));
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(cap);

  const rows = await db.query(sql, params);
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    category: row.category,
    action: row.action,
    detail: row.detail,
    ip: row.ip,
    at: row.created_at,
  }));
}

module.exports = { append, list };
