require("dotenv").config();

const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const express = require("express");

const DO_API = "https://api.digitalocean.com/v2";
const TOKEN = process.env.DIGITALOCEAN_API_TOKEN;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CACHE_TTL_MS = 5 * 60 * 1000;
const PER_PAGE = 200;
const PAGE_CONCURRENCY = 2;
const CACHE_FILE = path.join(__dirname, "data", "droplet-cache.json");
const LIST_FULL_LIMIT = 400;

if (!TOKEN || TOKEN === "your_token_here") {
  console.error("Missing DIGITALOCEAN_API_TOKEN in .env");
  process.exit(1);
}

/** @type {Map<string, { id: number, name: string }>} */
const ipToDroplet = new Map();
/** @type {Map<string, number>} actionId -> dropletId */
const actionToDroplet = new Map();

let lastRefreshAt = null;
let lastRefreshError = null;
let refreshInFlight = null;
let cacheRefreshing = false;
let cacheKnownTotal = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ingestDroplets(droplets, targetMap = ipToDroplet) {
  for (const droplet of droplets || []) {
    for (const ip of publicIPv4s(droplet)) {
      targetMap.set(ip, { id: droplet.id, name: droplet.name });
    }
  }
}

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return 0;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const rows = parsed.droplets || parsed;
    if (!Array.isArray(rows)) return 0;
    for (const row of rows) {
      if (row && row.ip && row.id) ipToDroplet.set(row.ip, { id: row.id, name: row.name || "" });
    }
    lastRefreshAt = parsed.lastRefreshAt || null;
    console.log(`Loaded ${ipToDroplet.size} public IPv4(s) from disk cache`);
    return ipToDroplet.size;
  } catch (err) {
    console.error("Could not load disk cache:", err.message);
    return 0;
  }
}

function saveDiskCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const droplets = Array.from(ipToDroplet.entries()).map(([ip, info]) => ({
      ip,
      id: info.id,
      name: info.name,
    }));
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ lastRefreshAt, count: droplets.length, droplets })
    );
  } catch (err) {
    console.error("Could not save disk cache:", err.message);
  }
}

function doHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function publicIPv4s(droplet) {
  const nets = (droplet.networks && droplet.networks.v4) || [];
  return nets.filter((n) => n.type === "public" && n.ip_address).map((n) => n.ip_address);
}

function mapDoError(status, body) {
  const id = body && (body.id || body.error);
  const message =
    (body && (body.message || body.error_message)) ||
    "DigitalOcean API request failed";

  if (status === 401 || status === 403) {
    return {
      status: 401,
      error: "Invalid or unauthorized DigitalOcean API token. Check DIGITALOCEAN_API_TOKEN and token scopes.",
    };
  }
  if (status === 429) {
    return {
      status: 429,
      error: "DigitalOcean API rate limit reached. Wait a moment and try again.",
    };
  }
  if (status === 404) {
    return { status: 404, error: message || "Droplet or action not found on DigitalOcean." };
  }
  if (status === 422) {
    return { status: 422, error: message };
  }
  return { status: status >= 400 ? status : 502, error: message, details: id || undefined };
}

async function doFetch(url, options = {}, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...doHeaders(), ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(60000),
    });
  } catch (err) {
    const error = new Error("Unable to reach the DigitalOcean API");
    error.status = 502;
    error.cause = err;
    throw error;
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1);
    console.warn(`DO ${res.status} on ${url} — retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return doFetch(url, options, attempt + 1);
  }

  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }

  if (!res.ok) {
    const mapped = mapDoError(res.status, body);
    const error = new Error(mapped.error);
    error.status = mapped.status;
    error.details = mapped.details;
    throw error;
  }

  return { res, body };
}

async function fetchAllDroplets() {
  cacheRefreshing = true;
  try {
    const first = await doFetch(`${DO_API}/droplets?per_page=${PER_PAGE}&page=1`);
    ingestDroplets(first.body.droplets);
    const total = (first.body.meta && first.body.meta.total) || (first.body.droplets || []).length;
    cacheKnownTotal = total;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    console.log(`DO droplets: ${total} total, ${pages} pages — fetching concurrently`);

    let nextPage = 2;
    async function worker() {
      while (true) {
        const page = nextPage++;
        if (page > pages) return;
        try {
          const { body } = await doFetch(`${DO_API}/droplets?per_page=${PER_PAGE}&page=${page}`);
          ingestDroplets(body.droplets);
        } catch (err) {
          console.error(`Droplet page ${page} failed: ${err.message}`);
        }
        if (page === pages || page % 25 === 0) {
          console.log(`Droplet cache progress: ${ipToDroplet.size} IPs after page ${page}/${pages}`);
          saveDiskCache();
        }
      }
    }

    const workers = Array.from({ length: Math.min(PAGE_CONCURRENCY, Math.max(0, pages - 1)) }, () => worker());
    await Promise.all(workers);

    lastRefreshAt = new Date().toISOString();
    lastRefreshError = null;
    saveDiskCache();
    return ipToDroplet.size;
  } finally {
    cacheRefreshing = false;
  }
}

function refreshCache() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetchAllDroplets()
    .then((count) => {
      console.log(`Droplet cache refreshed: ${count} public IPv4(s) at ${lastRefreshAt}`);
      return count;
    })
    .catch((err) => {
      lastRefreshError = err.message;
      console.error("Droplet cache refresh failed:", err.message);
      throw err;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function cachedList(limit) {
  const rows = Array.from(ipToDroplet.entries()).map(([ip, info]) => ({
    ip,
    id: info.id,
    name: info.name,
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip));
  if (limit && rows.length > limit) return rows.slice(0, limit);
  return rows;
}

function searchDroplets(query, limit = 50) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const [ip, info] of ipToDroplet) {
    if (
      ip.includes(needle) ||
      String(info.id).includes(needle) ||
      (info.name && info.name.toLowerCase().includes(needle))
    ) {
      out.push({ ip, id: info.id, name: info.name });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function rememberIp(ip, droplet) {
  const info = { id: droplet.id, name: droplet.name || "" };
  ipToDroplet.set(ip, info);
  return info;
}

async function dropletsByName(name) {
  const { body } = await doFetch(
    `${DO_API}/droplets?name=${encodeURIComponent(name)}&per_page=200`
  );
  return body.droplets || [];
}

async function fetchOkOrNull(url) {
  try {
    const { body } = await doFetch(url);
    return body;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function resolveDropletByIp(ip) {
  const cached = ipToDroplet.get(ip);
  if (cached) return cached;

  try {
    const hosts = await dns.reverse(ip);
    for (const host of hosts) {
      const name = String(host || "").replace(/\.$/, "");
      if (!name) continue;
      const droplets = await dropletsByName(name);
      const match =
        droplets.find((d) => publicIPv4s(d).includes(ip)) ||
        (droplets.length === 1 ? droplets[0] : null);
      if (match) return rememberIp(ip, match);
    }
  } catch (err) {
    if (err.code !== "ENOTFOUND" && err.code !== "ENODATA") {
      console.warn(`PTR lookup failed for ${ip}:`, err.message);
    }
  }

  const reserved = await fetchOkOrNull(`${DO_API}/reserved_ips/${ip}`);
  if (reserved && reserved.reserved_ip && reserved.reserved_ip.droplet) {
    return rememberIp(ip, reserved.reserved_ip.droplet);
  }

  const floating = await fetchOkOrNull(`${DO_API}/floating_ips/${ip}`);
  if (floating && floating.floating_ip && floating.floating_ip.droplet) {
    return rememberIp(ip, floating.floating_ip.droplet);
  }

  return null;
}

const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const ACTION_TYPES = {
  power_cycle: { type: "power_cycle", label: "power cycle" },
  restart: { type: "power_cycle", label: "power cycle" },
  reboot: { type: "power_cycle", label: "power cycle" },
  stop: { type: "power_off", label: "stop" },
  start: { type: "power_on", label: "start" },
};

function parseIp(raw) {
  let ip = String(raw || "").trim();
  const named = ip.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)\s*$/);
  if (named) ip = named[1];
  return ip;
}

function normalizeActionStatus(status) {
  return String(status || "unknown")
    .toLowerCase()
    .replace(/_/g, "-");
}

function summarizeDroplet(droplet, fallbackIp) {
  const ips = publicIPv4s(droplet);
  const region = droplet.region || {};
  return {
    id: droplet.id,
    name: droplet.name,
    status: droplet.status,
    region: region.slug || region.name || null,
    size: droplet.size_slug || null,
    memory: droplet.memory || null,
    vcpus: droplet.vcpus || null,
    disk: droplet.disk || null,
    ip: fallbackIp || ips[0] || null,
    ips,
  };
}

async function fetchDropletById(id) {
  const { body } = await doFetch(`${DO_API}/droplets/${id}`);
  return body.droplet;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Vary", "*");
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
    );
  });
  next();
});

const pkg = require("./package.json");

app.get("/api/version", (_req, res) => {
  res.json({ version: pkg.version, name: pkg.name });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    droplets: ipToDroplet.size,
    knownTotal: cacheKnownTotal,
    refreshing: Boolean(cacheRefreshing || refreshInFlight),
    lastRefreshAt,
    lastRefreshError,
  });
});

app.get("/api/droplets", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const refreshing = Boolean(cacheRefreshing || refreshInFlight);
    if (q) {
      let droplets = searchDroplets(q);
      if (!droplets.length && IPV4.test(q)) {
        const found = await resolveDropletByIp(q);
        if (found) droplets = [{ ip: q, id: found.id, name: found.name }];
      }
      return res.json({
        droplets,
        count: ipToDroplet.size,
        knownTotal: cacheKnownTotal,
        refreshing,
        lastRefreshAt,
        lastRefreshError,
      });
    }

    const count = ipToDroplet.size;
    const truncated = count > LIST_FULL_LIMIT;
    res.json({
      droplets: truncated ? [] : cachedList(),
      count,
      knownTotal: cacheKnownTotal,
      truncated,
      refreshing,
      lastRefreshAt,
      lastRefreshError,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/refresh", (req, res) => {
  refreshCache().catch(() => {});
  res.json({
    ok: true,
    started: true,
    count: ipToDroplet.size,
    knownTotal: cacheKnownTotal,
    refreshing: true,
    lastRefreshAt,
  });
});

async function runDropletAction(req, res, next, requested) {
  try {
    const ip = parseIp(req.body && req.body.ip);
    if (!ip) {
      return res.status(400).json({ error: "Missing ip. Send JSON { \"ip\": \"x.x.x.x\" }." });
    }
    if (!IPV4.test(ip)) {
      return res.status(400).json({ error: `"${ip}" is not a valid IPv4 address.` });
    }

    const key = String(requested || (req.body && req.body.action) || "power_cycle").toLowerCase();
    const spec = ACTION_TYPES[key];
    if (!spec) {
      return res.status(400).json({
        error: "Unknown action. Use power_cycle, stop, or start.",
      });
    }

    const droplet = await resolveDropletByIp(ip);
    if (!droplet) {
      return res.status(404).json({
        error: `No droplet found with public IPv4 ${ip}. Check the address, or wait if the IP was just assigned.`,
      });
    }

    const live = await fetchDropletById(droplet.id);
    const { body } = await doFetch(`${DO_API}/droplets/${droplet.id}/actions`, {
      method: "POST",
      body: JSON.stringify({ type: spec.type }),
    });

    const action = body.action || {};
    const actionId = action.id;
    if (actionId) {
      actionToDroplet.set(String(actionId), droplet.id);
    }

    res.json({
      ok: true,
      action: key,
      action_type: spec.type,
      action_label: spec.label,
      action_id: actionId,
      status: normalizeActionStatus(action.status || "in-progress"),
      droplet_id: droplet.id,
      droplet_name: live && live.name ? live.name : droplet.name,
      droplet_status: live && live.status,
      ip,
    });
  } catch (err) {
    next(err);
  }
}

app.get("/api/droplet", async (req, res, next) => {
  try {
    const ip = parseIp(req.query.ip);
    if (!ip || !IPV4.test(ip)) {
      return res.status(400).json({ error: "Pass a valid ?ip= public IPv4 address." });
    }
    const found = await resolveDropletByIp(ip);
    if (!found) {
      return res.status(404).json({ error: `No droplet found with public IPv4 ${ip}.` });
    }
    const live = await fetchDropletById(found.id);
    res.json({ droplet: summarizeDroplet(live, ip) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/reboot", (req, res, next) => runDropletAction(req, res, next, "power_cycle"));
app.post("/api/action", (req, res, next) => runDropletAction(req, res, next, req.body && req.body.action));

app.get("/api/action-status/:actionId", async (req, res, next) => {
  try {
    const actionId = String(req.params.actionId || "").trim();
    const dropletIdRaw = req.query.droplet_id || actionToDroplet.get(actionId);

    if (!actionId) {
      return res.status(400).json({ error: "Missing action id." });
    }
    if (!dropletIdRaw) {
      return res.status(400).json({
        error: "Missing droplet_id. Pass ?droplet_id= or run an action from this app so it can be tracked.",
      });
    }

    const dropletId = String(dropletIdRaw);
    let action = {};
    try {
      const { body } = await doFetch(`${DO_API}/droplets/${dropletId}/actions/${actionId}`);
      action = body.action || {};
    } catch (_err) {
      const { body } = await doFetch(`${DO_API}/actions/${actionId}`);
      action = body.action || {};
    }

    let dropletStatus = null;
    let dropletName = null;
    try {
      const live = await fetchDropletById(dropletId);
      dropletStatus = live.status;
      dropletName = live.name;
    } catch (_) {}

    res.json({
      action_id: action.id || Number(actionId),
      droplet_id: action.resource_id || Number(dropletId),
      droplet_name: dropletName,
      droplet_status: dropletStatus,
      status: normalizeActionStatus(action.status),
      type: action.type,
      started_at: action.started_at,
      completed_at: action.completed_at,
    });
  } catch (err) {
    next(err);
  }
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Surrogate-Control", "no-store");
    },
  })
);

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  console.error("Request error:", err.message);
  res.status(status).json({
    error: err.message || "Internal server error",
    ...(err.details ? { details: err.details } : {}),
  });
});

async function start() {
  loadDiskCache();

  app.listen(PORT, HOST, () => {
    console.log(`Droplet reboot app listening on http://${HOST}:${PORT}`);
  });

  try {
    await refreshCache();
  } catch (err) {
    console.error("Initial droplet fetch failed (server will still start):", err.message);
  }

  setInterval(() => {
    refreshCache().catch(() => {});
  }, CACHE_TTL_MS).unref();
}

start();
