const LINODE_API = "https://api.linode.com/v4";
const PAGE_SIZE = 500;
const TICKET_TTL_MS = 3 * 60 * 1000;
const SCOPE_RECHECK_MS = 10 * 60 * 1000;

/**
 * Linode support tickets need a token with the account:read_write scope. The instance token
 * usually only has linodes:*, so LINODE_SUPPORT_TOKEN can supply a separate, broader token.
 */
function createLinodeSupport(token) {
  let cache = { rows: [], total: null, fetchedAt: 0, error: null };
  let inFlight = null;
  let access = { ok: null, reason: null, checkedAt: 0 };

  async function apiFetch(urlPath, options = {}) {
    let res;
    try {
      res = await fetch(`${LINODE_API}${urlPath}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      const error = new Error(`Unable to reach the Linode API (${err.name === "TimeoutError" ? "request timed out" : err.message})`);
      error.status = 502;
      throw error;
    }
    const text = await res.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { errors: [{ reason: text }] };
      }
    }
    if (!res.ok) {
      const reason =
        (Array.isArray(body.errors) && body.errors.map((e) => (e.field ? `${e.field}: ` : "") + e.reason).join("; ")) ||
        `HTTP ${res.status}`;
      const error = new Error(
        res.status === 401 || res.status === 403
          ? `Linode token cannot access support tickets (${reason}). It needs the Account: Read/Write scope.`
          : `Linode: ${reason}`
      );
      error.status = res.status === 401 || res.status === 403 ? 403 : res.status >= 500 ? 502 : res.status;
      error.scope = res.status === 401 || res.status === 403;
      throw error;
    }
    return body;
  }

  function slim(t) {
    const entity = t.entity || null;
    return {
      id: t.id,
      summary: t.summary || "",
      description: t.description || "",
      status: t.status || "",
      severity: t.severity == null ? null : Number(t.severity),
      opened: t.opened || null,
      opened_by: t.opened_by || "",
      updated: t.updated || null,
      updated_by: t.updated_by || "",
      closed: t.closed || null,
      closable: Boolean(t.closable),
      entity: entity ? { id: entity.id, label: entity.label, type: entity.type } : null,
    };
  }

  async function checkAccess(force = false) {
    if (!force && access.checkedAt && Date.now() - access.checkedAt < SCOPE_RECHECK_MS) return access;
    try {
      await apiFetch(`/support/tickets?page_size=25`);
      access = { ok: true, reason: null, checkedAt: Date.now() };
    } catch (err) {
      access = { ok: err.scope ? false : access.ok, reason: err.message, checkedAt: Date.now() };
    }
    return access;
  }

  async function fetchRecent() {
    const body = await apiFetch(`/support/tickets?page=1&page_size=${PAGE_SIZE}`, {
      headers: { "X-Filter": JSON.stringify({ "+order_by": "updated", "+order": "desc" }) },
    });
    cache = { rows: (body.data || []).map(slim), total: body.results || null, fetchedAt: Date.now(), error: null };
    access = { ok: true, reason: null, checkedAt: Date.now() };
    return cache;
  }

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = fetchRecent()
      .catch((err) => {
        cache.error = err.message;
        if (err.scope) access = { ok: false, reason: err.message, checkedAt: Date.now() };
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function recent({ force = false } = {}) {
    if (force || !cache.fetchedAt) await refresh();
    else if (Date.now() - cache.fetchedAt > TICKET_TTL_MS) refresh().catch(() => {});
    return cache;
  }

  async function getTicket(id) {
    const [ticket, replies] = await Promise.all([
      apiFetch(`/support/tickets/${Number(id)}`),
      apiFetch(`/support/tickets/${Number(id)}/replies?page_size=${PAGE_SIZE}`),
    ]);
    return {
      ticket: slim(ticket),
      replies: (replies.data || []).map((r) => ({
        id: r.id,
        from_name: r.created_by || "",
        is_staff: Boolean(r.from_linode),
        date: r.created || null,
        description: r.description || "",
      })),
    };
  }

  async function createTicket({ summary, description, linodeId, severity }) {
    const payload = { summary, description };
    if (linodeId) payload.linode_id = Number(linodeId);
    if (severity) payload.severity = Number(severity);
    const body = await apiFetch("/support/tickets", { method: "POST", body: JSON.stringify(payload) });
    const ticket = slim(body);
    cache.rows = [ticket, ...cache.rows.filter((t) => t.id !== ticket.id)];
    refresh().catch(() => {});
    return ticket;
  }

  async function reply(id, description) {
    const body = await apiFetch(`/support/tickets/${Number(id)}/replies`, {
      method: "POST",
      body: JSON.stringify({ description }),
    });
    refresh().catch(() => {});
    return body;
  }

  async function close(id) {
    await apiFetch(`/support/tickets/${Number(id)}/close`, { method: "POST" });
    refresh().catch(() => {});
    return { ok: true };
  }

  function start() {
    checkAccess(true)
      .then((a) => {
        if (a.ok) refresh().catch(() => {});
        else console.warn("Linode support tickets unavailable:", a.reason);
      })
      .catch(() => {});
    setInterval(() => {
      if (access.ok) refresh().catch(() => {});
    }, TICKET_TTL_MS).unref();
  }

  return { checkAccess, recent, getTicket, createTicket, reply, close, start, access: () => access };
}

module.exports = { createLinodeSupport };
