const fs = require("fs");
const path = require("path");
const { settleWithReachability, unreachableMessage } = require("../lib/reachability");

const LINODE_API = "https://api.linode.com/v4";
const PER_PAGE = 500;
const CACHE_FILE = path.join(__dirname, "..", "data", "linode-cache.json");
const LIST_FULL_LIMIT = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** X-Filter rejects "+or" and entity.id on /account/maintenance, so each active status is fetched separately. */
const ACTIVE_MAINTENANCE_STATUSES = ["pending", "scheduled", "started", "in_progress"];
const MAINTENANCE_TTL_MS = 5 * 60 * 1000;
const TRANSITIONAL_STATUSES = {
  booting: "Booting",
  rebooting: "Rebooting",
  shutting_down: "Shutting down",
  provisioning: "Provisioning",
  migrating: "Migrating",
  rebuilding: "Rebuilding",
  cloning: "Cloning",
  restoring: "Restoring",
  resizing: "Resizing",
  deleting: "Deleting",
};

const ACTION_TYPES = {
  power_cycle: { path: (id) => `/linode/instances/${id}/reboot`, method: "POST", label: "power cycle" },
  restart: { path: (id) => `/linode/instances/${id}/reboot`, method: "POST", label: "power cycle" },
  reboot: { path: (id) => `/linode/instances/${id}/reboot`, method: "POST", label: "power cycle" },
  stop: { path: (id) => `/linode/instances/${id}/shutdown`, method: "POST", label: "stop" },
  start: { path: (id) => `/linode/instances/${id}/boot`, method: "POST", label: "start" },
};

function publicIpv4(instance) {
  const ips = instance && instance.ipv4;
  if (!Array.isArray(ips)) return null;
  return ips.find((ip) => ip && !String(ip).startsWith("192.168.")) || ips[0] || null;
}

function createLinodeProvider(token) {
  /** @type {Map<string, { id: number, name: string }>} */
  const ipToInstance = new Map();
  let lastRefreshAt = null;
  let lastRefreshError = null;
  let refreshInFlight = null;
  let cacheRefreshing = false;
  let cacheKnownTotal = null;
  /** @type {Map<number, object[]>} */
  let maintenanceByLinode = new Map();
  let maintenanceFetchedAt = 0;
  let maintenanceError = null;
  let maintenanceInFlight = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function headers(extra = {}) {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    };
  }

  function ingestInstances(instances) {
    for (const inst of instances || []) {
      const ip = publicIpv4(inst);
      if (ip) {
        ipToInstance.set(ip, {
          id: inst.id,
          name: inst.label || String(inst.id),
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
      console.log(`Loaded ${ipToInstance.size} Linode IP(s) from disk cache`);
      return ipToInstance.size;
    } catch (err) {
      console.error("Could not load Linode disk cache:", err.message);
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
      console.error("Could not save Linode disk cache:", err.message);
    }
  }

  function mapError(status, body) {
    const errors = body && body.errors;
    const message =
      (Array.isArray(errors) && errors.map((e) => e.reason || e.field).filter(Boolean).join("; ")) ||
      (body && body.error) ||
      "Linode API request failed";
    if (status === 401 || status === 403) {
      return {
        status: 403,
        error: `Linode rejected the request (HTTP ${status}): ${message}. Check LINODE_API_TOKEN scopes.`,
      };
    }
    if (status === 429) {
      return { status: 429, error: "Linode API rate limit reached. Wait and try again." };
    }
    if (status === 404) {
      return { status: 404, error: message || "Linode not found." };
    }
    if (status >= 500) {
      return { status: 502, error: `Linode API error (HTTP ${status}): ${message}. Try again shortly.` };
    }
    return { status: status >= 400 ? status : 502, error: `Linode: ${message}` };
  }

  async function apiFetch(urlPath, options = {}, attempt = 0) {
    let res;
    try {
      res = await fetch(`${LINODE_API}${urlPath}`, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
        signal: options.signal || AbortSignal.timeout(60000),
      });
    } catch (err) {
      const error = new Error("Unable to reach the Linode API");
      error.status = 502;
      error.cause = err;
      throw error;
    }

    const method = String(options.method || "GET").toUpperCase();
    const retryable = res.status === 429 || (res.status >= 500 && method === "GET");
    if (retryable && attempt < 6) {
      const waitMs = 1500 * (attempt + 1);
      console.warn(`Linode ${res.status} on ${urlPath} — retrying in ${waitMs}ms`);
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
    const nextMap = new Map(ipToInstance);
    try {
      let page = 1;
      let pages = 1;

      while (page <= pages) {
        const qs = new URLSearchParams({
          page: String(page),
          page_size: String(PER_PAGE),
        });
        const { body } = await apiFetch(`/linode/instances?${qs}`);
        const instances = body.data || [];
        for (const inst of instances) {
          const ip = publicIpv4(inst);
          if (ip) {
            nextMap.set(ip, {
              id: inst.id,
              name: inst.label || String(inst.id),
            });
          }
        }
        ipToInstance.clear();
        for (const [ip, info] of nextMap) ipToInstance.set(ip, info);
        pages = body.pages || 1;
        cacheKnownTotal = body.results || ipToInstance.size;
        if (page % 5 === 0 || page === pages) {
          lastRefreshAt = new Date().toISOString();
          saveDiskCache();
          console.log(`Linode cache progress: ${ipToInstance.size} IPs (page ${page}/${pages})`);
        }
        page += 1;
      }

      lastRefreshError = null;
      saveDiskCache();
      console.log(`Linode cache refreshed: ${ipToInstance.size} public IP(s)`);
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
        console.error("Linode cache refresh failed:", err.message);
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
    const { body } = await apiFetch(`/linode/instances/${id}`);
    return body;
  }

  async function resolveByIp(ip) {
    if (ipToInstance.has(ip)) return ipToInstance.get(ip);

    try {
      const { body } = await apiFetch("/linode/instances", {
        headers: { "X-Filter": JSON.stringify({ ipv4: ip }) },
      });
      for (const inst of body.data || []) {
        ingestInstances([inst]);
        const matchIp = publicIpv4(inst);
        if (matchIp === ip) {
          saveDiskCache();
          return ipToInstance.get(ip);
        }
      }
    } catch (err) {
      console.warn(`Linode IP filter lookup failed for ${ip}:`, err.message);
    }

    let page = 1;
    let pages = 1;
    while (page <= pages && page <= 120) {
      const qs = new URLSearchParams({
        page: String(page),
        page_size: String(PER_PAGE),
      });
      const { body } = await apiFetch(`/linode/instances?${qs}`);
      pages = body.pages || 1;
      for (const inst of body.data || []) {
        ingestInstances([inst]);
        if (publicIpv4(inst) === ip) {
          saveDiskCache();
          return ipToInstance.get(ip);
        }
      }
      page += 1;
    }
    return null;
  }

  function summarize(instance, fallbackIp) {
    const label = (instance.label || "").trim();
    const specs = instance.specs || {};
    const diskMb = specs.disk || null;
    return {
      id: instance.id,
      name: label || String(instance.id),
      label: label || null,
      hostname: label || null,
      status: instance.status,
      power_status: instance.status === "running" ? "running" : "stopped",
      server_status: instance.status,
      region: instance.region || null,
      size: instance.type || null,
      memory: specs.memory || null,
      vcpus: specs.vcpus || null,
      disk: diskMb ? Math.round(diskMb / 1024) : null,
      ip: fallbackIp || publicIpv4(instance),
      ips: instance.ipv4 || [],
    };
  }

  function actionComplete(action, instance, elapsedMs) {
    const status = String(instance.status || "").toLowerCase();
    if (action === "stop") {
      return status === "offline" || status === "stopped" || status === "shutting_down";
    }
    if (action === "power_cycle") {
      if (elapsedMs < 12000) return false;
      return status === "running";
    }
    if (action === "start") {
      if (elapsedMs < 8000) return false;
      return status === "running";
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
      const error = new Error(`No Linode found with public IPv4 ${ip}.`);
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
      instance_name: live.label || found.name,
      instance_status: live.status,
      power_status: live.status === "running" ? "running" : "stopped",
      server_status: live.status,
      ip,
    };
  }

  function needsReachabilityCheck(action, instance, startedAt) {
    if (action === "stop") return false;
    return actionComplete(action, instance, Date.now() - startedAt);
  }

  function getActionStatus(action, instance, startedAt, probe) {
    const elapsed = Date.now() - startedAt;
    const apiComplete = actionComplete(action, instance, elapsed);
    const { status, note } = settleWithReachability({ apiComplete, elapsedMs: elapsed, probe });
    return {
      action,
      instance_id: instance.id,
      instance_name: instance.label,
      instance_status: instance.status,
      power_status: instance.status === "running" ? "running" : "stopped",
      server_status: instance.status,
      reachable: probe ? probe.reachable : null,
      open_ports: probe ? probe.open_ports : null,
      note,
      status,
      elapsed_ms: elapsed,
    };
  }

  async function fetchActiveMaintenance() {
    const next = new Map();
    for (const status of ACTIVE_MAINTENANCE_STATUSES) {
      let page = 1;
      let pages = 1;
      while (page <= pages && page <= 20) {
        const qs = new URLSearchParams({ page: String(page), page_size: String(PER_PAGE) });
        const { body } = await apiFetch(`/account/maintenance?${qs}`, {
          headers: { "X-Filter": JSON.stringify({ status }) },
        });
        pages = body.pages || 1;
        for (const m of body.data || []) {
          if (!m.entity || m.entity.type !== "linode") continue;
          const id = Number(m.entity.id);
          if (!next.has(id)) next.set(id, []);
          next.get(id).push({
            type: m.type,
            status: m.status,
            reason: m.reason || "",
            when: m.when || null,
            start_time: m.start_time || null,
            description: m.description || "",
            source: m.source || "",
            policy: m.maintenance_policy_set || "",
          });
        }
        page += 1;
      }
    }
    maintenanceByLinode = next;
    maintenanceFetchedAt = Date.now();
    maintenanceError = null;
    return next;
  }

  function refreshMaintenance() {
    if (maintenanceInFlight) return maintenanceInFlight;
    maintenanceInFlight = fetchActiveMaintenance()
      .catch((err) => {
        maintenanceError = err.message;
        console.error("Linode maintenance refresh failed:", err.message);
        throw err;
      })
      .finally(() => {
        maintenanceInFlight = null;
      });
    return maintenanceInFlight;
  }

  async function maintenanceFor(linodeId) {
    try {
      if (!maintenanceFetchedAt) await refreshMaintenance();
      else if (Date.now() - maintenanceFetchedAt > MAINTENANCE_TTL_MS) refreshMaintenance().catch(() => {});
    } catch (err) {
      return { items: [], error: err.message };
    }
    const items = (maintenanceByLinode.get(Number(linodeId)) || []).slice();
    items.sort((a, b) => String(a.when || "").localeCompare(String(b.when || "")));
    return { items, error: maintenanceError };
  }

  function startMaintenanceRefresh() {
    refreshMaintenance().catch(() => {});
    setInterval(() => refreshMaintenance().catch(() => {}), MAINTENANCE_TTL_MS).unref();
  }

  function assessHealth(instance, probe, maintenance) {
    const status = String(instance.status || "").toLowerCase();
    const items = maintenance || [];
    const active = items.find((m) => m.status === "started" || m.status === "in_progress");
    const upcoming = items.find((m) => m.status === "scheduled" || m.status === "pending");
    const api = `API: status ${status || "?"}`;

    let level = "ok";
    let label = "Healthy";
    let message = "Linode reports the server running and it answers on the network.";

    if (active) {
      level = "warn";
      label = "Maintenance";
      message = `Linode maintenance is in progress (${active.type}): ${String(active.reason || "platform maintenance").trim().replace(/\.+$/, "")}.`;
    } else if (status === "billing_suspension") {
      level = "down";
      label = "Suspended";
      message = "Linode has suspended this server for billing reasons.";
    } else if (status === "offline" || status === "stopped") {
      level = "stopped";
      label = "Stopped";
      message = "The server is powered off. Use Start to boot it.";
    } else if (TRANSITIONAL_STATUSES[status]) {
      level = "info";
      label = TRANSITIONAL_STATUSES[status];
      message = `Linode reports the server is ${TRANSITIONAL_STATUSES[status].toLowerCase()}.`;
    } else if (status === "running" && probe && !probe.reachable) {
      level = "down";
      label = "Unreachable";
      message = unreachableMessage(probe, "Linode");
    } else if (status && status !== "running") {
      level = "warn";
      label = "Degraded";
      message = `Linode reports status "${status}".`;
    }

    if (upcoming && !active) {
      const when = upcoming.when ? new Date(upcoming.when + (/Z|[+-]\d\d:?\d\d$/.test(upcoming.when) ? "" : "Z")) : null;
      const reason = String(upcoming.reason || "platform maintenance").trim().replace(/\.+$/, "");
      message += ` Upcoming maintenance (${upcoming.type}${when ? ", " + when.toISOString().replace("T", " ").slice(0, 16) + " UTC" : ""}): ${reason}.`;
      if (level === "ok") {
        level = "info";
        label = "Maintenance scheduled";
      }
    }

    return { level, label, message, api };
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
      console.error("Initial Linode fetch failed:", err.message);
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
    needsReachabilityCheck,
    getActionStatus,
    assessHealth,
    maintenanceFor,
    startMaintenanceRefresh,
    health,
    listResponse,
    startBackgroundRefresh,
  };
}

module.exports = { createLinodeProvider };
