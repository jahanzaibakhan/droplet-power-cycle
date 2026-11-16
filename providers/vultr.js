const fs = require("fs");
const path = require("path");

const VULTR_API = "https://api.vultr.com/v2";
const PER_PAGE = 500;
const CACHE_FILE = path.join(__dirname, "..", "data", "vultr-cache.json");
const LIST_FULL_LIMIT = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** The account has tens of thousands of tickets; only the newest pages are indexed (newest first). */
const TICKET_PAGES = 2;
const TICKET_TTL_MS = 3 * 60 * 1000;
const TICKET_REF = /^[A-Z0-9]{2,6}-[A-Z0-9]{3,8}$/;
const REACHABILITY_WAIT_MS = 4 * 60 * 1000;

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
  let ticketCache = { rows: [], total: null, fetchedAt: 0, error: null };
  let ticketRefreshInFlight = null;
  let severityCache = null;

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
    const upstream = String((body && (body.error || body.message)) || "").trim();
    const message = upstream || "Vultr API request failed";
    if (status === 401 || status === 403) {
      return {
        status: 403,
        error:
          `Vultr rejected the request (HTTP ${status})` +
          (upstream ? `: ${upstream}` : "") +
          ". Check VULTR_API_KEY permissions and the API IP allowlist (157.245.109.69).",
      };
    }
    if (status === 429) {
      return { status: 429, error: "Vultr API rate limit reached. Wait and try again." };
    }
    if (status === 404) {
      return { status: 404, error: upstream || "Not found on Vultr." };
    }
    if (status >= 500) {
      return {
        status: 502,
        error: `Vultr API error (HTTP ${status})` + (upstream ? `: ${upstream}` : "") + ". Try again shortly.",
      };
    }
    return { status: status >= 400 ? status : 502, error: `Vultr: ${message}` };
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
      const reason = err && err.name === "TimeoutError" ? "request timed out" : (err && err.cause && err.cause.code) || err.message;
      const error = new Error(`Unable to reach the Vultr API (${reason})`);
      error.status = 502;
      error.cause = err;
      throw error;
    }

    const method = String(options.method || "GET").toUpperCase();
    // Non-GET 5xx responses may still have been applied upstream (e.g. a ticket was created), so never replay them.
    const retryable = res.status === 429 || (res.status >= 500 && method === "GET");
    if (retryable && attempt < 6) {
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
    const nextMap = new Map(ipToInstance);
    try {
      let cursor = "";
      let page = 0;

      while (true) {
        page += 1;
        const qs = new URLSearchParams({ per_page: String(PER_PAGE) });
        if (cursor) qs.set("cursor", cursor);
        const { body } = await apiFetch(`/instances?${qs}`);
        const instances = body.instances || [];
        for (const inst of instances) {
          if (inst && inst.main_ip) {
            nextMap.set(inst.main_ip, {
              id: inst.id,
              name: inst.label || inst.hostname || inst.id,
            });
          }
        }
        ipToInstance.clear();
        for (const [ip, info] of nextMap) ipToInstance.set(ip, info);
        cacheKnownTotal = (body.meta && body.meta.total) || ipToInstance.size;
        cursor = (body.meta && body.meta.links && body.meta.links.next) || "";
        if (page % 5 === 0 || !cursor) {
          lastRefreshAt = new Date().toISOString();
          saveDiskCache();
          console.log(`Vultr cache progress: ${ipToInstance.size} IPs (page ${page})`);
        }
        if (!cursor) break;
      }

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
    let pages = 0;
    while (true) {
      pages += 1;
      const qs = new URLSearchParams({ per_page: String(PER_PAGE) });
      if (cursor) qs.set("cursor", cursor);
      const { body } = await apiFetch(`/instances?${qs}`);
      for (const inst of body.instances || []) {
        if (inst && inst.main_ip) {
          ipToInstance.set(inst.main_ip, {
            id: inst.id,
            name: inst.label || inst.hostname || inst.id,
          });
          if (inst.main_ip === ip) {
            saveDiskCache();
            return ipToInstance.get(ip);
          }
        }
      }
      cursor = (body.meta && body.meta.links && body.meta.links.next) || "";
      if (!cursor) break;
      if (pages > 120) break;
    }
    return null;
  }

  function summarize(instance, fallbackIp) {
    const label = (instance.label || "").trim();
    const hostname = (instance.hostname || "").trim();
    return {
      id: instance.id,
      name: label || hostname || instance.id,
      label: label || null,
      hostname: hostname || null,
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
      lock_reason: instance.lock_reason || null,
      os: instance.os || null,
      date_created: instance.date_created || null,
    };
  }

  /**
   * Vultr keeps reporting active/running/ok when the host node under an instance fails,
   * so the API state alone is combined with a live TCP probe and any open tickets.
   */
  function assessHealth(instance, probe, tickets) {
    const status = String(instance.status || "").toLowerCase();
    const power = String(instance.power_status || "").toLowerCase();
    const server = String(instance.server_status || "").toLowerCase();
    const lock = String(instance.lock_reason || "").trim();
    const openTickets = (tickets || []).filter((t) => isOpenTicket(t.status));
    const api = `API: status ${status || "?"} · power ${power || "?"} · server ${server || "?"}`;

    let level = "ok";
    let label = "Healthy";
    let message = "Vultr reports the instance running and it answers on the network.";

    if (status === "pending") {
      level = "info";
      label = "Provisioning";
      message = "Vultr is still provisioning this instance.";
    } else if (status === "suspended") {
      level = "down";
      label = "Suspended";
      message = "Vultr has suspended this instance" + (lock ? ` (${lock})` : "") + ". Contact Vultr support.";
    } else if (status === "closed") {
      level = "down";
      label = "Closed";
      message = "This instance is closed on Vultr.";
    } else if (lock || server === "locked") {
      level = "warn";
      label = "Locked";
      message = "Vultr has locked this instance" + (lock ? `: ${lock}` : "") + ". Power actions may be rejected.";
    } else if (power === "stopped") {
      level = "stopped";
      label = "Stopped";
      message = "The instance is powered off. Use Start to boot it.";
    } else if (server === "installingbooting") {
      level = "info";
      label = "Booting";
      message = "Vultr reports the instance is installing or booting.";
    } else if (probe && !probe.reachable) {
      level = "down";
      label = "Unreachable";
      message =
        "Vultr reports the instance as running, but it is not answering on ports " +
        probe.ports.map((p) => p.port).join(", ") +
        ". This usually points to a host node, network, or OS-level failure that the Vultr API does not expose.";
    } else if (server && server !== "ok") {
      level = "warn";
      label = "Degraded";
      message = `Vultr reports server status "${server}".`;
    }

    if (openTickets.length && level !== "ok") {
      message += ` ${openTickets.length} open ticket(s) are linked to this server — check the latest Vultr reply below.`;
    }

    return { level, label, message, api, open_tickets: openTickets.length };
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

  function needsReachabilityCheck(action, instance, startedAt) {
    if (action === "stop") return false;
    return actionComplete(action, instance, Date.now() - startedAt);
  }

  function getActionStatus(action, instance, startedAt, probe) {
    const elapsed = Date.now() - startedAt;
    const apiComplete = actionComplete(action, instance, elapsed);
    let status = apiComplete ? "completed" : "in-progress";
    let note = null;

    if (apiComplete && probe && !probe.reachable) {
      if (elapsed < REACHABILITY_WAIT_MS) {
        status = "in-progress";
        note = "Vultr reports running — waiting for the server to answer on the network…";
      } else {
        status = "unreachable";
        note =
          "Vultr reports the instance running, but it still does not answer on ports " +
          probe.ports.map((p) => p.port).join(", ") +
          ". Likely a host node or OS problem — consider raising a Vultr ticket.";
      }
    }

    return {
      action,
      instance_id: instance.id,
      instance_name: instance.label || instance.hostname,
      instance_status: instance.status,
      power_status: instance.power_status,
      server_status: instance.server_status,
      reachable: probe ? probe.reachable : null,
      open_ports: probe ? probe.open_ports : null,
      note,
      status,
      elapsed_ms: elapsed,
    };
  }

  function isOpenTicket(status) {
    const s = String(status || "").toLowerCase();
    return s === "open" || s === "feedback";
  }

  function ticketMentionsIp(ticket, ip) {
    if (!ip) return false;
    const re = new RegExp(`(^|[^\\d.])${ip.replace(/\./g, "\\.")}([^\\d.]|$)`);
    if (re.test(ticket.subject || "")) return true;
    return (ticket.linked_subscriptions || []).some((s) => re.test(s.description || ""));
  }

  function slimTicket(t) {
    return {
      reference: t.reference,
      subject: t.subject || "",
      status: t.status || t.entryStatus || "",
      severity: t.severity || "",
      severity_label: t.severity_label || "",
      date_created: t.date_created || null,
      date_closed: t.date_closed || null,
      date_last_entry: t.date_last_entry || null,
      last_reply_name: t.last_reply_name || "",
      ticket_opener: t.ticket_opener || "",
      linked_subscriptions: (t.linked_subscriptions || []).map((s) => ({
        uuid: s.uuid,
        type: s.type,
        status: s.status,
        description: s.description,
      })),
    };
  }

  async function fetchRecentTickets() {
    const rows = [];
    let cursor = "";
    let total = null;
    for (let page = 0; page < TICKET_PAGES; page += 1) {
      const qs = new URLSearchParams({ per_page: String(PER_PAGE) });
      if (cursor) qs.set("cursor", cursor);
      const { body } = await apiFetch(`/tickets?${qs}`);
      for (const t of body.tickets || []) rows.push(slimTicket(t));
      total = (body.meta && body.meta.total) || total;
      cursor = (body.meta && body.meta.links && body.meta.links.next) || "";
      if (!cursor) break;
    }
    ticketCache = { rows, total, fetchedAt: Date.now(), error: null };
    return ticketCache;
  }

  function refreshTickets() {
    if (ticketRefreshInFlight) return ticketRefreshInFlight;
    ticketRefreshInFlight = fetchRecentTickets()
      .catch((err) => {
        ticketCache.error = err.message;
        console.error("Vultr ticket refresh failed:", err.message);
        throw err;
      })
      .finally(() => {
        ticketRefreshInFlight = null;
      });
    return ticketRefreshInFlight;
  }

  async function ensureTickets({ force = false } = {}) {
    const stale = Date.now() - ticketCache.fetchedAt > TICKET_TTL_MS;
    if (force || !ticketCache.fetchedAt) {
      await refreshTickets();
    } else if (stale) {
      refreshTickets().catch(() => {});
    }
    return ticketCache;
  }

  const TICKET_FILTERS = {
    open: (s) => s === "open" || s === "feedback",
    resolved: (s) => s === "resolved",
    closed: (s) => s === "closed" || s === "archived",
    all: () => true,
  };

  async function listTickets({ filter = "open", q = "", limit = 200, force = false } = {}) {
    const cache = await ensureTickets({ force });
    const test = TICKET_FILTERS[filter] || TICKET_FILTERS.open;
    const needle = String(q || "").trim().toLowerCase();
    let rows = cache.rows.filter((t) => test(String(t.status).toLowerCase()));
    if (needle) {
      rows = rows.filter(
        (t) =>
          t.reference.toLowerCase().includes(needle) ||
          t.subject.toLowerCase().includes(needle) ||
          t.ticket_opener.toLowerCase().includes(needle) ||
          t.last_reply_name.toLowerCase().includes(needle) ||
          t.linked_subscriptions.some((s) => String(s.description || "").toLowerCase().includes(needle))
      );
    }

    if (needle && !rows.length && TICKET_REF.test(needle.toUpperCase())) {
      try {
        const { body } = await apiFetch(`/tickets/${encodeURIComponent(needle.toUpperCase())}`);
        if (body.ticket) rows = [slimTicket(body.ticket)];
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }

    const counts = { open: 0, resolved: 0, closed: 0, all: cache.rows.length };
    for (const t of cache.rows) {
      const s = String(t.status).toLowerCase();
      if (TICKET_FILTERS.open(s)) counts.open += 1;
      else if (TICKET_FILTERS.resolved(s)) counts.resolved += 1;
      else if (TICKET_FILTERS.closed(s)) counts.closed += 1;
    }

    return {
      tickets: rows.slice(0, limit),
      matched: rows.length,
      counts,
      scanned: cache.rows.length,
      account_total: cache.total,
      fetched_at: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
      refreshing: Boolean(ticketRefreshInFlight),
      error: cache.error,
    };
  }

  async function ticketsForInstance(instanceId, ip) {
    let cache;
    try {
      cache = await ensureTickets();
    } catch (err) {
      return { tickets: [], error: err.message };
    }
    const tickets = cache.rows.filter(
      (t) =>
        t.linked_subscriptions.some((s) => s.uuid === instanceId) ||
        ticketMentionsIp(t, ip)
    );
    tickets.sort((a, b) => String(b.date_last_entry || "").localeCompare(String(a.date_last_entry || "")));
    return { tickets: tickets.slice(0, 15), error: null };
  }

  async function getTicket(reference) {
    const ref = String(reference || "").trim().toUpperCase();
    if (!TICKET_REF.test(ref)) {
      const error = new Error("Invalid ticket reference.");
      error.status = 400;
      throw error;
    }
    const [{ body: tb }, { body: rb }] = await Promise.all([
      apiFetch(`/tickets/${encodeURIComponent(ref)}`),
      apiFetch(`/tickets/${encodeURIComponent(ref)}/replies?per_page=${PER_PAGE}`),
    ]);
    const replies = (rb.replies || []).map((r) => ({
      index: r.index,
      from_name: r.from_name || "",
      from_type: r.from_type || "",
      date: r.date || null,
      description: r.description || "",
      attachments: (r.attachments || []).map((a) => ({ filename: a.filename, type: a.context_type })),
    }));
    replies.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    return { ticket: slimTicket(tb.ticket || {}), replies, replies_total: (rb.meta && rb.meta.total) || replies.length };
  }

  async function getSeverityOptions() {
    if (severityCache && Date.now() - severityCache.at < 6 * 60 * 60 * 1000) return severityCache.data;
    const { body } = await apiFetch("/tickets/severity-options");
    const data = { severity: body.severity || [], severity_custom: body.severity_custom || [] };
    severityCache = { at: Date.now(), data };
    return data;
  }

  async function createTicket({ subject, description, severity, subUuid, category }) {
    const payload = { subject, description };
    if (severity) payload.severity = severity;
    if (subUuid) payload["sub-uuid"] = subUuid;
    if (category) payload.category = category;
    const { body } = await apiFetch("/tickets", { method: "POST", body: JSON.stringify(payload) });
    const ticket = body.ticket ? slimTicket(body.ticket) : null;
    if (ticket && ticket.reference) {
      ticketCache.rows = [ticket, ...ticketCache.rows.filter((t) => t.reference !== ticket.reference)];
    }
    refreshTickets().catch(() => {});
    return { ticket, raw_reference: (body.ticket && body.ticket.reference) || body.reference || null };
  }

  async function replyTicket(reference, description) {
    const ref = String(reference || "").trim().toUpperCase();
    if (!TICKET_REF.test(ref)) {
      const error = new Error("Invalid ticket reference.");
      error.status = 400;
      throw error;
    }
    await apiFetch(`/tickets/${encodeURIComponent(ref)}/replies`, {
      method: "POST",
      body: JSON.stringify({ description }),
    });
    refreshTickets().catch(() => {});
    return { ok: true, reference: ref };
  }

  function startTicketRefresh() {
    refreshTickets().catch(() => {});
    setInterval(() => refreshTickets().catch(() => {}), TICKET_TTL_MS).unref();
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
    assessHealth,
    runAction,
    needsReachabilityCheck,
    getActionStatus,
    health,
    listResponse,
    startBackgroundRefresh,
    listTickets,
    ticketsForInstance,
    getTicket,
    getSeverityOptions,
    createTicket,
    replyTicket,
    startTicketRefresh,
    isTicketRef: (ref) => TICKET_REF.test(String(ref || "").trim().toUpperCase()),
  };
}

module.exports = { createVultrProvider };
