const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_FILE = path.join(__dirname, "..", "data", "operation-logs.json");
const MAX_LOGS = 500;

const OPERATION_LABELS = {
  power_cycle: "Power cycle",
  restart: "Power cycle",
  reboot: "Power cycle",
  stop: "Stop",
  start: "Start",
};

function loadLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    if (Array.isArray(parsed.logs)) return parsed.logs;
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (err) {
    console.error("Could not load operation logs:", err.message);
    return [];
  }
}

function saveLogs(logs) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify({ logs: logs.slice(0, MAX_LOGS) }));
  } catch (err) {
    console.error("Could not save operation logs:", err.message);
  }
}

function formatOperation(action) {
  return OPERATION_LABELS[String(action || "").toLowerCase()] || String(action || "Unknown");
}

function appendLog({ provider, upstream, ip, operation }) {
  const names = {
    digitalocean: "DigitalOcean",
    vultr: "Vultr",
    linode: "Linode",
  };
  const logs = loadLogs();
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    provider: names[String(provider || "").toLowerCase()] || provider || "Unknown",
    upstream: String(upstream || ip || "—").trim() || "—",
    ip: ip || null,
    operation: formatOperation(operation),
  };
  logs.unshift(entry);
  saveLogs(logs);
  return entry;
}

function listLogs(limit = 100) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), MAX_LOGS);
  return loadLogs().slice(0, cap);
}

module.exports = { appendLog, listLogs, formatOperation };
