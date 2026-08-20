const fs = require("fs");
const path = require("path");

const VULTR_API = "https://api.vultr.com/v2";
const PER_PAGE = 500;
const CACHE_FILE = path.join(__dirname, "..", "data", "vultr-cache.json");
const LIST_FULL_LIMIT = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;

const ACTION_TYPES = {
  power_cycle: { path: (id) => `/instances/${id}/reboot`, method: "POST", label: "power cycle" },
  restart: { path: (id) => `/instances/${id}/reboot`, method: "POST", label: "power cycle" },
  reboot: { path: (id) => `/instances/${id}/reboot`, method: "POST", label: "power cycle" },
  stop: { path: (id) => `/instances/${id}/halt`, method: "POST", label: "stop" },
  start: { path: (id) => `/instances/${id}/start`, method: "POST", label: "start" },
};

function createVultrProvider(token) {
  /** @type {Map<string, { id: string, name: string }>} */
  const ipToInstance = new Map();
  let lastRefreshAt = null;
  let lastRefreshError = null;
  let refreshInFlight = null;
  let cacheRefreshing = false;
  let cacheKnownTotal = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function headers() {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  function ingestInstances(instances) {
    for (const inst of instances || []) {
      if (inst && inst.main_ip) {
        ipToInstance.set(inst.main_ip, {
          id: inst.id,
          name: inst.label || inst.hostname || inst.id,
        });
      }
    }
  }

  function loadDiskCache() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return 0;
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      const rows = parsed.instances || parsed;
      if (!Array.isArray(rows)) return 0;
      for (const row of rows) {
        if (row && row.ip && row.id) {
          ipToInstance.set(row.ip, { id: row.id, name: row.name || "" });
        }
      }
      lastRefreshAt = parsed.lastRefreshAt || null;
      console.log(`Loaded ${ipToInstance.size} Vultr IP(s) from disk cache`);
      return ipToInstance.size;
    } catch (err) {
      console.error("Could not load Vultr disk cache:", err.message);
      return 0;
    }
  }

  function saveDiskCache() {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      const instances = Array.from(ipToInstance.entries()).map(([ip, info]) => ({
        ip,
        id: info.id,
        name: info.name,
      }));
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ lastRefreshAt, count: instances.length, instances })
      );
    } catch (err) {
      console.error("Could not save Vultr disk cache:", err.message);
    }
  }

  function mapError(status, body) {
    const message = (body && (body.error || body.message)) || "Vultr API request failed";
    if (status === 401 || status === 403) {
      return {
        status: 401,
        error:
          "Invalid or unauthorized Vultr API key. Check VULTR_API_KEY and IP allowlist (157.245.109.69).",
      };
    }
    if (status === 429) {
      return { status: 429, error: "Vultr API rate limit reached. Wait and try again." };
    }
    if (status === 404) {
      return { status: 404, error: message || "Instance not found on Vultr." };
    }
    return { status: status >= 400 ? status : 502, error: message };
  }

  async function apiFetch(urlPath, options = {}, attempt = 0) {
    let res;
    try {
      res = await fetch(`${VULTR_API}${urlPath}`, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
        signal: options.signal || AbortSignal.timeout(60000),
      });
    } catch (err) {
      const error = new Error("Unable to reach the Vultr API");
      error.status = 502;
      error.cause = err;
      throw error;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const waitMs = 1500 * (attempt + 1);
      console.warn(`Vultr ${res.status} on ${urlPath} — retrying in ${waitMs}ms`);
      await sleep(waitMs);
      return apiFetch(urlPath, options, attempt + 1);
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
      const mapped = mapError(res.status, body);
      const error = new Error(mapped.error);
      error.status = mapped.status;
      throw error;
    }

    if (res.status === 204) return { res, body: { ok: true } };
    return { res, body };
  }

  async function fetchAllInstances() {
    cacheRefreshing = true;
    try {
      let cursor = "";
      let page = 0;
      ipToInstance.clear();

      while (true) {
        page += 1;
        const qs = new URLSearchParams({ per_page: String(PER_PAGE) });
        if (cursor) qs.set("cursor", cursor);
        const { body } = await apiFetch(`/instances?${qs}`);
        const instances = body.instances || [];
        ingestInstances(instances);
        cacheKnownTotal = (body.meta && body.meta.total) || ipToInstance.size;
        cursor = (body.meta && body.meta.links && body.meta.links.next) || "";
        if (!cursor) break;
        if (page % 5 === 0) {
          console.log(`Vultr cache progress: ${ipToInstance.size} IPs (page ${page})`);
          saveDiskCache();
        }
      }

      lastRefreshAt = new Date().toISOString();
      lastRefreshError = null;
      saveDiskCache();
      console.log(`Vultr cache refreshed: ${ipToInstance.size} public IP(s)`);
      return ipToInstance.size;
    } finally {
      cacheRefreshing = false;
    }
  }

  function refreshCache() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = fetchAllInstances()
      .catch((err) => {
        lastRefreshError = err.message;
        console.error("Vultr cache refresh failed:", err.message);
        throw err;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  function cachedList(limit) {
    const rows = Array.from(ipToInstance.entries()).map(([ip, info]) => ({
      ip,
      id: info.id,
      name: info.name,
    }));
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip));
    if (limit && rows.length > limit) return rows.slice(0, limit);
    return rows;
  }

  function searchInstances(query, limit = 50) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const [ip, info] of ipToInstance) {
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

  async function fetchInstanceById(id) {
    const { body } = await apiFetch(`/instances/${id}`);
    return body.instance;
  }

  async function resolveByIp(ip) {
    if (ipToInstance.has(ip)) return ipToInstance.get(ip);

    let cursor = "";
    while (true) {
      const qs = new URLSearchParams({ per_page: String(PER_PAGE) });
      if (cursor) qs.set("cursor", cursor);
      const { body } = await apiFetch(`/instances?${qs}`);
      for (const inst of body.instances || []) {
        ingestInstances([inst]);
        if (inst.main_ip === ip) {
          return ipToInstance.get(ip);
        }
      }
      cursor = (body.meta && body.meta.links && body.meta.links.next) || "";
      if (!cursor) break;
    }
    return null;
  }

  function summarize(instance, fallbackIp) {
    return {
      id: instance.id,
      name: instance.label || instance.hostname || instance.id,
      status: instance.status,
      power_status: instance.power_status,
      server_status: instance.server_status,
      region: instance.region || null,
      size: instance.plan || null,
      memory: instance.ram || null,
      vcpus: instance.vcpu_count || null,
      disk: instance.disk || null,
      ip: fallbackIp || instance.main_ip || null,
      ips: instance.main_ip ? [instance.main_ip] : [],
    };
  }

  function actionComplete(action, instance, elapsedMs) {
    const power = String(instance.power_status || "").toLowerCase();
    const server = String(instance.server_status || "").toLowerCase();
    if (action === "stop") return power === "stopped";
    if (elapsedMs < 8000) return false;
    if (action === "power_cycle" || action === "start") {
      return power === "running" && (server === "ok" || server === "");
    }
    return false;
  }

  async function runAction(ip, requested) {
    const key = String(requested || "power_cycle").toLowerCase();
    const spec = ACTION_TYPES[key];
    if (!spec) {
      const error = new Error("Unknown action. Use power_cycle, stop, or start.");
      error.status = 400;
      throw error;
    }

    const found = await resolveByIp(ip);
    if (!found) {
      const error = new Error(`No Vultr instance found with public IPv4 ${ip}.`);
      error.status = 404;
      throw error;
    }

    const live = await fetchInstanceById(found.id);
    await apiFetch(spec.path(found.id), { method: spec.method });

    return {
      ok: true,
      action: key,
      action_label: spec.label,
      instance_id: found.id,
      instance_name: live.label || live.hostname || found.name,
      instance_status: live.status,
      power_status: live.power_status,
      server_status: live.server_status,
      ip,
    };
  }

  function getActionStatus(action, instance, startedAt) {
    const elapsed = Date.now() - startedAt;
    const complete = actionComplete(action, instance, elapsed);
    return {
      action,
      instance_id: instance.id,
      instance_name: instance.label || instance.hostname,
      instance_status: instance.status,
      power_status: instance.power_status,
      server_status: instance.server_status,
      status: complete ? "completed" : "in-progress",
      elapsed_ms: elapsed,
    };
  }

  function health() {
    return {
      instances: ipToInstance.size,
      knownTotal: cacheKnownTotal,
      refreshing: Boolean(cacheRefreshing || refreshInFlight),
      lastRefreshAt,
      lastRefreshError,
    };
  }

  function listResponse(q) {
    const refreshing = Boolean(cacheRefreshing || refreshInFlight);
    if (q) {
      return {
        instances: searchInstances(q),
        count: ipToInstance.size,
        knownTotal: cacheKnownTotal,
        refreshing,
        lastRefreshAt,
        lastRefreshError,
      };
    }
    const count = ipToInstance.size;
    const truncated = count > LIST_FULL_LIMIT;
    return {
      instances: truncated ? [] : cachedList(),
      count,
      knownTotal: cacheKnownTotal,
      truncated,
      refreshing,
      lastRefreshAt,
      lastRefreshError,
    };
  }

  function startBackgroundRefresh() {
    loadDiskCache();
    refreshCache().catch((err) => {
      console.error("Initial Vultr fetch failed:", err.message);
    });
    setInterval(() => refreshCache().catch(() => {}), CACHE_TTL_MS).unref();
  }

  return {
    loadDiskCache,
    refreshCache,
    resolveByIp,
    fetchInstanceById,
    summarize,
    runAction,
    getActionStatus,
    health,
    listResponse,
    startBackgroundRefresh,
  };
}

module.exports = { createVultrProvider };
