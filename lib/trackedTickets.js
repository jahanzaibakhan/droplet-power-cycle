const db = require("./db");

const STATUSES = ["open", "waiting", "resolved", "closed"];
const PRIORITIES = ["urgent", "high", "normal", "low"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tracked_tickets (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    reference VARCHAR(64) NULL,
    subject VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    priority VARCHAR(16) NULL,
    ip VARCHAR(45) NULL,
    resource_id VARCHAR(64) NULL,
    resource_label VARCHAR(255) NULL,
    created_by INT NULL,
    created_by_name VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_tt_provider_updated (provider, updated_at),
    KEY idx_tt_ip (ip)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tracked_ticket_events (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ticket_id INT UNSIGNED NOT NULL,
    user_id INT NULL,
    username VARCHAR(64) NULL,
    kind VARCHAR(16) NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_tte_ticket (ticket_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function ensureSchema() {
  for (const sql of SCHEMA) await db.query(sql);
}

function toRow(r) {
  return {
    id: r.id,
    provider: r.provider,
    reference: r.reference || null,
    subject: r.subject,
    description: r.description,
    status: r.status,
    priority: r.priority || null,
    ip: r.ip || null,
    resource_id: r.resource_id || null,
    resource_label: r.resource_label || null,
    created_by: r.created_by,
    created_by_name: r.created_by_name || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function addEvent(ticketId, user, kind, body) {
  await db.query(
    `INSERT INTO tracked_ticket_events (ticket_id, user_id, username, kind, body, created_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ticketId, user.userId || null, user.username || null, kind, String(body || "")]
  );
  await db.query("UPDATE tracked_tickets SET updated_at = UTC_TIMESTAMP() WHERE id = ?", [ticketId]);
}

async function list(provider, { limit = 500 } = {}) {
  const rows = await db.query(
    `SELECT * FROM tracked_tickets WHERE provider = ? ORDER BY updated_at DESC LIMIT ${Math.min(Number(limit) || 500, 1000)}`,
    [provider]
  );
  return rows.map(toRow);
}

async function get(provider, id) {
  const rows = await db.query("SELECT * FROM tracked_tickets WHERE provider = ? AND id = ? LIMIT 1", [provider, Number(id)]);
  if (!rows[0]) return null;
  const events = await db.query(
    "SELECT id, user_id, username, kind, body, created_at FROM tracked_ticket_events WHERE ticket_id = ? ORDER BY created_at ASC, id ASC",
    [Number(id)]
  );
  return { ticket: toRow(rows[0]), events };
}

async function create(provider, fields, user) {
  const result = await db.query(
    `INSERT INTO tracked_tickets
       (provider, reference, subject, description, status, priority, ip, resource_id, resource_label,
        created_by, created_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [
      provider,
      fields.reference || null,
      fields.subject,
      fields.description,
      fields.priority || null,
      fields.ip || null,
      fields.resourceId != null ? String(fields.resourceId) : null,
      fields.resourceLabel || null,
      user.userId || null,
      user.username || null,
    ]
  );
  const id = result.insertId;
  await addEvent(id, user, "created", "Ticket drafted in Dropkick and copied for the provider portal.");
  return id;
}

async function update(provider, id, changes, user) {
  const current = await get(provider, id);
  if (!current) return null;
  const t = current.ticket;

  if (changes.reference !== undefined) {
    const ref = String(changes.reference || "").trim().slice(0, 64) || null;
    if (ref !== t.reference) {
      await db.query("UPDATE tracked_tickets SET reference = ? WHERE id = ?", [ref, t.id]);
      await addEvent(t.id, user, "reference", ref ? `Provider ticket number set to ${ref}.` : "Provider ticket number cleared.");
    }
  }
  if (changes.status !== undefined && changes.status !== t.status) {
    await db.query("UPDATE tracked_tickets SET status = ? WHERE id = ?", [changes.status, t.id]);
    await addEvent(t.id, user, "status", `Status changed from ${t.status} to ${changes.status}.`);
  }
  if (changes.note) {
    await addEvent(t.id, user, "note", String(changes.note).slice(0, 20000));
  }
  return get(provider, id);
}

module.exports = { ensureSchema, list, get, create, update, STATUSES, PRIORITIES };
