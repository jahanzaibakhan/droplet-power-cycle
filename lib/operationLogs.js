const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");

const LEGACY_FILE = path.join(__dirname, "..", "data", "operation-logs.json");
const MAX_LOGS = 500;

const OPERATION_LABELS = {
  power_cycle: "Power cycle",
  restart: "Power cycle",
  reboot: "Power cycle",
  stop: "Stop",
  start: "Start",
};

const PROVIDER_NAMES = {
  digitalocean: "DigitalOcean",
  vultr: "Vultr",
  linode: "Linode",
};

function formatOperation(action) {
  return OPERATION_LABELS[String(action || "").toLowerCase()] || String(action || "Unknown");
}

function formatProvider(provider) {
  return PROVIDER_NAMES[String(provider || "").toLowerCase()] || provider || "Unknown";
}

async function appendLog({ provider, upstream, ip, operation, userId, username }) {
  try {
    const id = crypto.randomUUID();
    const providerLabel = formatProvider(provider);
    const operationLabel = formatOperation(operation);
    await db.query(
      `INSERT INTO operation_logs (id, user_id, username, provider, upstream, ip, operation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [
        id,
        userId || null,
        username || null,
        providerLabel,
        String(upstream || ip || "—").trim() || "—",
        ip || null,
        operationLabel,
      ]
    );
    await trimOld();
    return {
      id,
      at: new Date().toISOString(),
      user_id: userId || null,
      username: username || null,
      provider: providerLabel,
      upstream: String(upstream || ip || "—").trim() || "—",
      ip: ip || null,
      operation: operationLabel,
    };
  } catch (err) {
    console.error("operation log append failed:", err.message);
    return null;
  }
}

async function trimOld() {
  await db.query(
    `DELETE FROM operation_logs WHERE id NOT IN (
       SELECT id FROM (
         SELECT id FROM operation_logs ORDER BY created_at DESC LIMIT ?
       ) AS recent
     )`,
    [MAX_LOGS]
  );
}

async function listLogs(limit = 100, { userId } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), MAX_LOGS);
  const params = [];
  let sql = `SELECT id, user_id, username, provider, upstream, ip, operation, created_at
             FROM operation_logs`;
  if (userId) {
    sql += " WHERE user_id = ?";
    params.push(Number(userId));
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(cap);

  const rows = await db.query(sql, params);
  return rows.map((row) => ({
    id: row.id,
    at: row.created_at,
    user_id: row.user_id,
    username: row.username || "—",
    provider: row.provider,
    upstream: row.upstream,
    ip: row.ip,
    operation: row.operation,
  }));
}

async function importLegacyJson() {
  if (!fs.existsSync(LEGACY_FILE)) return 0;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
  } catch {
    return 0;
  }
  const logs = Array.isArray(parsed.logs) ? parsed.logs : Array.isArray(parsed) ? parsed : [];
  if (!logs.length) return 0;

  const existing = await db.query("SELECT COUNT(*) AS c FROM operation_logs");
  if (Number(existing[0].c) > 0) return 0;

  let imported = 0;
  for (const row of logs.slice(0, MAX_LOGS)) {
    await db.query(
      `INSERT INTO operation_logs (id, user_id, username, provider, upstream, ip, operation, created_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [
        row.id || crypto.randomUUID(),
        row.provider || "Unknown",
        row.upstream || "—",
        row.ip || null,
        row.operation || "Unknown",
        row.at ? new Date(row.at) : new Date(),
      ]
    );
    imported += 1;
  }
  return imported;
}

async function deleteLogs(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const clean = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!clean.length) return 0;
  const placeholders = clean.map(() => "?").join(", ");
  const result = await db.query(`DELETE FROM operation_logs WHERE id IN (${placeholders})`, clean);
  return Number(result.affectedRows) || 0;
}

module.exports = { appendLog, listLogs, deleteLogs, formatOperation, importLegacyJson };
