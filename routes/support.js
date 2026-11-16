const express = require("express");
const tracked = require("../lib/trackedTickets");

const IP_IN_TEXT = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
const TRACKED_REF = /^DK-(\d+)$/i;

const GROUP_FILTERS = {
  open: (t) => t.group === "open",
  awaiting: (t) => t.group === "open" && t.awaiting === "you",
  resolved: (t) => t.group === "resolved",
  closed: (t) => t.group === "closed",
  all: () => true,
};

const TEMPLATE_PORTALS = {
  digitalocean: {
    label: "DigitalOcean",
    new_ticket_url: "https://cloudsupport.digitalocean.com/s/createticket",
    portal_url: "https://cloudsupport.digitalocean.com/s/",
  },
  linode: {
    label: "Linode",
    new_ticket_url: "https://cloud.linode.com/support/tickets",
    portal_url: "https://cloud.linode.com/support/tickets",
  },
  vultr: {
    label: "Vultr",
    new_ticket_url: "https://my.vultr.com/support/",
    portal_url: "https://my.vultr.com/support/",
  },
};

function mentionsIp(text, ip) {
  if (!ip || !text) return false;
  const re = new RegExp(`(^|[^\\d.])${ip.replace(/\./g, "\\.")}([^\\d.]|$)`);
  return re.test(text);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function trackedAdapter(provider, { resolveResource, setup }) {
  const portal = TEMPLATE_PORTALS[provider];

  function normalize(t) {
    const group = t.status === "resolved" ? "resolved" : t.status === "closed" ? "closed" : "open";
    return {
      provider,
      reference: `DK-${t.id}`,
      external_reference: t.reference,
      subject: t.subject,
      status: t.status,
      group,
      severity: t.priority,
      severity_label: t.priority ? t.priority[0].toUpperCase() + t.priority.slice(1) : "",
      created_at: t.created_at,
      updated_at: t.updated_at,
      last_reply_by: t.created_by_name || "",
      opened_by: t.created_by_name || "",
      awaiting: t.status === "waiting" ? "provider" : t.reference ? null : "you",
      resource: t.resource_id || t.ip ? { id: t.resource_id, label: t.resource_label, ip: t.ip } : null,
      source: "tracked",
      ticket_url: null,
      can_reply: true,
      can_close: t.status !== "closed",
      can_resolve: t.status !== "resolved" && t.status !== "closed",
    };
  }

  function idFrom(ref) {
    const m = String(ref || "").match(TRACKED_REF);
    if (!m) throw httpError(400, "Invalid Dropkick ticket reference (expected DK-<number>).");
    return Number(m[1]);
  }

  return {
    async capabilities() {
      return {
        provider,
        label: portal.label,
        mode: "tracked",
        setup: setup ? await setup() : null,
        subject_max: 250,
        severities: tracked.PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })),
        severity_label: "Priority",
        statuses: tracked.STATUSES,
        new_ticket_url: portal.new_ticket_url,
        portal_url: portal.portal_url,
      };
    },
    async list() {
      const rows = await tracked.list(provider);
      return { tickets: rows.map(normalize), total: rows.length, fetched_at: new Date().toISOString(), refreshing: false, error: null };
    },
    async get(ref) {
      const found = await tracked.get(provider, idFrom(ref));
      if (!found) throw httpError(404, "Ticket not found.");
      const messages = [
        {
          from_name: found.ticket.created_by_name || "Dropkick",
          is_staff: false,
          kind: "description",
          date: found.ticket.created_at,
          body: found.ticket.description,
        },
        ...found.events
          .filter((e) => e.kind !== "created")
          .map((e) => ({ from_name: e.username || "Dropkick", is_staff: false, kind: e.kind, date: e.created_at, body: e.body })),
      ];
      return { ticket: normalize(found.ticket), messages, description: found.ticket.description };
    },
    async create(fields, user) {
      let resource = null;
      if (fields.ip) resource = await resolveResource(fields.ip);
      const id = await tracked.create(
        provider,
        {
          subject: fields.subject,
          description: fields.description,
          priority: tracked.PRIORITIES.includes(fields.severity) ? fields.severity : null,
          ip: fields.ip || null,
          resourceId: resource ? resource.id : null,
          resourceLabel: resource ? resource.name : null,
        },
        user
      );
      return { reference: `DK-${id}`, portal_url: portal.new_ticket_url, tracked: true };
    },
    async reply(ref, body, user) {
      const updated = await tracked.update(provider, idFrom(ref), { note: body }, user);
      if (!updated) throw httpError(404, "Ticket not found.");
      return { ok: true };
    },
    async update(ref, changes, user) {
      const clean = {};
      if (changes.status !== undefined) {
        if (!tracked.STATUSES.includes(changes.status)) throw httpError(400, "Unknown status.");
        clean.status = changes.status;
      }
      if (changes.reference !== undefined) clean.reference = changes.reference;
      if (changes.action === "close") clean.status = "closed";
      if (changes.action === "resolve") clean.status = "resolved";
      const updated = await tracked.update(provider, idFrom(ref), clean, user);
      if (!updated) throw httpError(404, "Ticket not found.");
      return { ok: true };
    },
  };
}

function vultrAdapter(vultr) {
  function normalize(t) {
    const s = String(t.status || "").toLowerCase();
    const group = s === "resolved" ? "resolved" : s === "closed" || s === "archived" ? "closed" : "open";
    const sub = (t.linked_subscriptions || [])[0];
    const ipMatch = sub && String(sub.description || "").match(IP_IN_TEXT);
    const staffLast = /vultr/i.test(t.last_reply_name || "");
    return {
      provider: "vultr",
      reference: t.reference,
      external_reference: null,
      subject: t.subject,
      status: s,
      group,
      severity: t.severity || null,
      severity_label: t.severity_label || "",
      created_at: t.date_created,
      updated_at: t.date_last_entry,
      last_reply_by: t.last_reply_name || "",
      opened_by: t.ticket_opener || "",
      awaiting: group === "open" ? (staffLast ? "you" : "provider") : null,
      resource: sub ? { id: sub.uuid, label: sub.description, ip: ipMatch ? ipMatch[0] : null } : null,
      source: "api",
      ticket_url: null,
      can_reply: s !== "archived",
      can_close: group === "open" || s === "resolved",
      can_resolve: group === "open",
    };
  }

  return {
    async capabilities() {
      let severities = [];
      try {
        severities = (await vultr.getSeverityOptions()).severity || [];
      } catch (_) {}
      return {
        provider: "vultr",
        label: "Vultr",
        mode: "api",
        setup: null,
        subject_max: 250,
        severities,
        severity_label: "Severity",
        new_ticket_url: TEMPLATE_PORTALS.vultr.new_ticket_url,
        portal_url: TEMPLATE_PORTALS.vultr.portal_url,
        coverage: "newest 1,000 tickets (reference search reaches older ones)",
      };
    },
    async list({ force, q }) {
      if (q && vultr.isTicketRef(q)) {
        const res = await vultr.listTickets({ filter: "all", q, force });
        const snap = vultr.ticketCacheSnapshot();
        const extra = res.tickets.filter((t) => !snap.rows.some((r) => r.reference === t.reference));
        return {
          tickets: [...extra, ...snap.rows].map(normalize),
          total: snap.total,
          fetched_at: snap.fetchedAt ? new Date(snap.fetchedAt).toISOString() : null,
          refreshing: false,
          error: snap.error,
        };
      }
      await vultr.ensureTickets({ force });
      const snap = vultr.ticketCacheSnapshot();
      return {
        tickets: snap.rows.map(normalize),
        total: snap.total,
        fetched_at: snap.fetchedAt ? new Date(snap.fetchedAt).toISOString() : null,
        refreshing: false,
        error: snap.error,
      };
    },
    async get(ref) {
      const data = await vultr.getTicket(ref);
      return {
        ticket: normalize(data.ticket),
        messages: data.replies.map((r) => ({
          from_name: r.from_name,
          is_staff: r.from_type === "staff",
          kind: "reply",
          date: r.date,
          body: r.description,
          attachments: r.attachments,
        })),
      };
    },
    async create(fields) {
      let subUuid = null;
      if (fields.ip) {
        const found = await vultr.resolveByIp(fields.ip);
        if (!found) throw httpError(404, `No Vultr instance found with public IPv4 ${fields.ip}. Clear the server field to raise an unlinked ticket.`);
        subUuid = found.id;
      }
      const severity = /^S[1-4]$/.test(String(fields.severity || "")) ? fields.severity : "";
      const result = await vultr.createTicket({ subject: fields.subject, description: fields.description, severity, subUuid });
      return { reference: (result.ticket && result.ticket.reference) || result.raw_reference };
    },
    async reply(ref, body) {
      await vultr.replyTicket(ref, body);
      return { ok: true };
    },
    async update(ref, changes) {
      if (changes.action === "close") return vultr.closeTicket(ref);
      if (changes.action === "resolve") return vultr.resolveTicket(ref);
      throw httpError(400, "Vultr tickets support close or resolve.");
    },
  };
}

function linodeApiAdapter(support) {
  const SEV = { 1: "Major impact", 2: "Moderate impact", 3: "Low impact", 4: "No impact" };

  function normalize(t) {
    const s = String(t.status || "").toLowerCase();
    const group = s === "closed" ? "closed" : "open";
    return {
      provider: "linode",
      reference: String(t.id),
      external_reference: null,
      subject: t.summary,
      status: s,
      group,
      severity: t.severity ? String(t.severity) : null,
      severity_label: t.severity ? SEV[t.severity] || "" : "",
      created_at: t.opened,
      updated_at: t.updated,
      last_reply_by: t.updated_by || "",
      opened_by: t.opened_by || "",
      awaiting: null,
      resource: t.entity ? { id: t.entity.id, label: t.entity.label, ip: (String(t.summary).match(IP_IN_TEXT) || [])[0] || null } : null,
      source: "api",
      ticket_url: `https://cloud.linode.com/support/tickets/${t.id}`,
      can_reply: s !== "closed",
      can_close: s !== "closed" && t.closable,
      can_resolve: false,
    };
  }

  function idFrom(ref) {
    if (!/^\d+$/.test(String(ref))) throw httpError(400, "Invalid Linode ticket ID.");
    return Number(ref);
  }

  return {
    async list({ force }) {
      const cache = await support.recent({ force });
      return {
        tickets: cache.rows.map(normalize),
        total: cache.total,
        fetched_at: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
        refreshing: false,
        error: cache.error,
      };
    },
    async get(ref) {
      const data = await support.getTicket(idFrom(ref));
      return {
        ticket: normalize(data.ticket),
        messages: [
          {
            from_name: data.ticket.opened_by,
            is_staff: false,
            kind: "description",
            date: data.ticket.opened,
            body: data.ticket.description,
          },
          ...data.replies.map((r) => ({ from_name: r.from_name, is_staff: r.is_staff, kind: "reply", date: r.date, body: r.description })),
        ],
      };
    },
    async create(fields, _user, linode) {
      let linodeId = null;
      if (fields.ip) {
        const found = await linode.resolveByIp(fields.ip);
        if (!found) throw httpError(404, `No Linode found with public IPv4 ${fields.ip}. Clear the server field to raise an unlinked ticket.`);
        linodeId = found.id;
      }
      const severity = /^[1-4]$/.test(String(fields.severity || "")) ? fields.severity : null;
      const ticket = await support.createTicket({
        summary: fields.subject.slice(0, 64),
        description: fields.description,
        linodeId,
        severity,
      });
      return { reference: String(ticket.id) };
    },
    async reply(ref, body) {
      await support.reply(idFrom(ref), body);
      return { ok: true };
    },
    async update(ref, changes) {
      if (changes.action === "close") return support.close(idFrom(ref));
      throw httpError(400, "Linode tickets can only be closed.");
    },
    capabilities: {
      provider: "linode",
      label: "Linode",
      mode: "api",
      setup: null,
      subject_max: 64,
      severities: Object.entries(SEV).map(([value, label]) => ({
        value,
        label: `${value} — ${label}`,
        description: "Your Linode account may not be allowed to set severity; leave unset if creation fails.",
      })),
      severity_label: "Severity",
      new_ticket_url: TEMPLATE_PORTALS.linode.new_ticket_url,
      portal_url: TEMPLATE_PORTALS.linode.portal_url,
      coverage: "newest 500 tickets",
    },
  };
}

function createSupportRouter({ vultr, linode, linodeSupport, resolveDroplet, operationLogs, opUser, parseIp, IPV4 }) {
  const router = express.Router();

  const linodeSetup = async () => {
    const a = linodeSupport ? await linodeSupport.checkAccess() : { ok: false, reason: "LINODE_API_TOKEN is not configured." };
    if (a.ok) return null;
    return {
      reason: a.reason || "The Linode token cannot access support tickets.",
      steps: [
        "In Linode Cloud Manager open Profile → API Tokens → Create a Personal Access Token.",
        "Set Account to Read/Write (everything else can stay No Access).",
        "Add it to .env on the Dropkick server as LINODE_SUPPORT_TOKEN=… and restart the app.",
      ],
    };
  };

  const adapters = {};
  if (resolveDroplet) {
    adapters.digitalocean = trackedAdapter("digitalocean", {
      resolveResource: async (ip) => resolveDroplet(ip),
    });
  }
  if (vultr) adapters.vultr = vultrAdapter(vultr);
  const linodeTracked = linode
    ? trackedAdapter("linode", { resolveResource: async (ip) => linode.resolveByIp(ip), setup: linodeSetup })
    : null;
  const linodeApi = linodeSupport ? linodeApiAdapter(linodeSupport) : null;

  async function adapterFor(provider) {
    if (provider === "linode") {
      if (!linode) throw httpError(404, "Linode is not configured.");
      const a = linodeSupport ? await linodeSupport.checkAccess() : { ok: false };
      return a.ok && linodeApi ? linodeApi : linodeTracked;
    }
    const adapter = adapters[provider];
    if (!adapter) throw httpError(404, "Unknown or unconfigured provider.");
    return adapter;
  }

  async function capabilitiesOf(adapter) {
    return typeof adapter.capabilities === "function" ? adapter.capabilities() : adapter.capabilities;
  }

  function filterTickets(tickets, { filter, q, ip, resourceId }) {
    const test = GROUP_FILTERS[filter] || GROUP_FILTERS.open;
    const needle = String(q || "").trim().toLowerCase();
    return tickets.filter((t) => {
      if (resourceId || ip) {
        const linked =
          (resourceId && t.resource && String(t.resource.id) === String(resourceId)) ||
          (ip && ((t.resource && t.resource.ip === ip) || mentionsIp(t.subject, ip) || mentionsIp(t.resource && t.resource.label, ip)));
        if (!linked) return false;
      }
      if (!test(t)) return false;
      if (!needle) return true;
      return [t.reference, t.external_reference, t.subject, t.opened_by, t.last_reply_by, t.resource && t.resource.label, t.resource && t.resource.ip]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }

  function counts(tickets) {
    const out = {};
    for (const key of Object.keys(GROUP_FILTERS)) out[key] = tickets.filter(GROUP_FILTERS[key]).length;
    return out;
  }

  function sortByActivity(rows) {
    return rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  }

  function log(req, provider, operation, upstream, ip) {
    operationLogs.appendLog({ provider, upstream: String(upstream).slice(0, 250), ip: ip || null, operation, ...opUser(req) });
  }

  router.get("/:provider/capabilities", async (req, res, next) => {
    try {
      res.json(await capabilitiesOf(await adapterFor(req.params.provider)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:provider/tickets", async (req, res, next) => {
    try {
      const adapter = await adapterFor(req.params.provider);
      const q = String(req.query.q || "").slice(0, 120);
      const data = await adapter.list({ force: req.query.refresh === "1", q });
      const all = data.tickets;
      const rows = sortByActivity(filterTickets(all, { filter: String(req.query.filter || "open"), q }));
      res.json({
        tickets: rows.slice(0, 300),
        matched: rows.length,
        counts: counts(all),
        scanned: all.length,
        account_total: data.total,
        fetched_at: data.fetched_at,
        error: data.error,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:provider/linked", async (req, res, next) => {
    try {
      const ip = parseIp(req.query.ip);
      const resourceId = String(req.query.resource_id || "").trim();
      if (ip && !IPV4.test(ip)) return res.status(400).json({ error: "Invalid IP." });
      const adapter = await adapterFor(req.params.provider);
      const data = await adapter.list({});
      const rows = sortByActivity(filterTickets(data.tickets, { filter: "all", ip, resourceId }));
      res.json({ tickets: rows.slice(0, 15), open: rows.filter((t) => t.group === "open").length, error: data.error });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:provider/tickets/:ref", async (req, res, next) => {
    try {
      const adapter = await adapterFor(req.params.provider);
      res.json(await adapter.get(req.params.ref));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:provider/tickets", async (req, res, next) => {
    try {
      const provider = req.params.provider;
      const adapter = await adapterFor(provider);
      const caps = await capabilitiesOf(adapter);
      const body = req.body || {};
      const subject = String(body.subject || "").trim();
      const description = String(body.description || "").trim();
      const severity = String(body.severity || "").trim();
      const ip = parseIp(body.ip);
      if (!subject || subject.length > caps.subject_max) {
        return res.status(400).json({ error: `Subject is required (max ${caps.subject_max} characters for ${caps.label}).` });
      }
      if (!description || description.length > 20000) {
        return res.status(400).json({ error: "Description is required (max 20,000 characters)." });
      }
      if (ip && !IPV4.test(ip)) return res.status(400).json({ error: `"${ip}" is not a valid IPv4 address.` });

      const user = opUser(req);
      const result = await adapter.create({ subject, description, severity, ip }, user, linode);
      log(req, provider, result.tracked ? "ticket_track" : "ticket_create", `${result.reference || "ticket"} · ${subject}`, ip);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:provider/tickets/:ref/replies", async (req, res, next) => {
    try {
      const provider = req.params.provider;
      const adapter = await adapterFor(provider);
      const description = String((req.body && req.body.description) || "").trim();
      if (!description || description.length > 20000) {
        return res.status(400).json({ error: "Reply text is required (max 20,000 characters)." });
      }
      await adapter.reply(req.params.ref, description, opUser(req));
      if (!TRACKED_REF.test(req.params.ref)) log(req, provider, "ticket_reply", `${req.params.ref} · reply`);
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:provider/tickets/:ref", async (req, res, next) => {
    try {
      const provider = req.params.provider;
      const adapter = await adapterFor(provider);
      const body = req.body || {};
      const changes = {
        action: ["close", "resolve"].includes(body.action) ? body.action : undefined,
        status: body.status,
        reference: body.reference,
      };
      const result = await adapter.update(req.params.ref, changes, opUser(req));
      if (changes.action) log(req, provider, `ticket_${changes.action}`, `${req.params.ref} · ${changes.action}`);
      res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSupportRouter };
