/* Support tickets UI shared by every provider. Uses helpers from the main script in index.html
   (esc, authFetch, PROVIDERS, provider, activeTab, showToast, confirmAction, …) at call time. */

const SP = {
  provider: null,
  caps: {},
  capsAt: {},
  filter: "open",
  searchTimer: null,
  listToken: 0,
  ticket: null,
  ticketProvider: null,
  newProvider: null,
  newServer: null,
  newLinked: [],
  checkToken: 0,
};

const SP_TEMPLATES = [
  {
    id: "down",
    label: "Server down",
    sev: "high",
    subject: "Server down | {ip}{region}",
    body:
      "Hi team,\n\nThe server below is down and not reachable. Please check the host node and network, restore it as soon as possible, and share the root cause.\n\n{server}Thanks,\nCloudways Team.",
  },
  {
    id: "steal",
    label: "High CPU steal / slow",
    sev: "medium",
    subject: "High CPU steal | {ip}",
    body:
      "Hi team,\n\nWe are seeing high CPU steal and slowness on the server below, which suggests contention on the host node. Please check the host and migrate the server if needed.\n\n{server}Thanks,\nCloudways Team.",
  },
  {
    id: "network",
    label: "Network / packet loss",
    sev: "medium",
    subject: "Packet loss | {ip}",
    body:
      "Hi team,\n\nThe server below has packet loss and intermittent connectivity. Please check the network path and the host node.\n\n{server}Thanks,\nCloudways Team.",
  },
  {
    id: "disk",
    label: "Disk / I/O errors",
    sev: "medium",
    subject: "Disk I/O errors | {ip}",
    body:
      "Hi team,\n\nThe server below is showing disk I/O errors (slow or failed writes, possible read-only filesystem). Please check the underlying storage on the host.\n\n{server}Thanks,\nCloudways Team.",
  },
  {
    id: "upgrade",
    label: "Upgrade / resize failed",
    sev: "medium",
    subject: "Unable to upgrade | {ip}",
    body:
      "Hi team,\n\nWe are unable to upgrade/resize the server below. Please check why the resize is failing and complete it from your side if possible.\n\n{server}Thanks,\nCloudways Team.",
  },
  {
    id: "maintenance",
    label: "Maintenance question",
    sev: "low",
    subject: "Maintenance query | {ip}",
    body:
      "Hi team,\n\nWe have a question about maintenance on the server below. Please confirm the schedule, expected impact, and duration.\n\n{server}Thanks,\nCloudways Team.",
  },
  { id: "other", label: "Other", sev: "", subject: "", body: "Hi team,\n\n\n\n{server}Thanks,\nCloudways Team." },
];

const SP_QUICK_API = [
  "Any update on this? The issue is still ongoing.",
  "Still down after a power cycle — please escalate.",
  "Please share the root cause once available.",
  "The issue is resolved now. Thank you for your help!",
];

const SP_QUICK_TRACKED = [
  "Ticket submitted in the provider portal.",
  "Provider replied — waiting on their next update.",
  "Provider asked for more details; replied in the portal.",
  "Issue resolved by the provider.",
];

const spEl = (id) => document.getElementById(id);

function spSetStatus(el, kind, text) {
  if (!text) {
    el.className = "status";
    el.textContent = "";
    return;
  }
  el.className = "status show " + kind;
  el.textContent = text;
}

function spOpenOverlay(el) {
  el.classList.add("show");
  el.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function spCloseOverlay(el) {
  el.classList.remove("show");
  el.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal-backdrop.show")) document.body.classList.remove("modal-open");
}

function spBtnClass(prov) {
  return prov === "vultr" ? " vultr" : prov === "linode" ? " linode" : "";
}

function spLabel(prov) {
  return (PROVIDERS[prov] && PROVIDERS[prov].label) || prov;
}

async function spJson(url, options) {
  const res = await authFetch(url, options);
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) throw new Error(data.error || "Request failed (HTTP " + res.status + ")");
  return data;
}

async function spCaps(prov, force) {
  if (!force && SP.caps[prov] && Date.now() - SP.capsAt[prov] < 60000) return SP.caps[prov];
  const caps = await spJson("/api/support/" + prov + "/capabilities");
  SP.caps[prov] = caps;
  SP.capsAt[prov] = Date.now();
  return caps;
}

function spSeverityFor(caps, level) {
  if (!level || !caps || !caps.severities || !caps.severities.length) return "";
  const values = caps.severities.map((s) => String(s.value));
  const order = { high: 0, medium: 1, low: 2 };
  if (values.includes("S1")) return ["S1", "S2", "S3"][order[level]];
  if (values.includes("1")) return ["1", "2", "3"][order[level]];
  if (values.includes("urgent")) return ["urgent", "high", "normal"][order[level]];
  return "";
}

function spStatusText(t) {
  if (t.source === "tracked" && t.status === "waiting") return "waiting";
  return t.status;
}

function spAwaitingBadge(t, prov) {
  if (t.group !== "open" || !t.awaiting) return "";
  if (t.awaiting === "you" && t.source === "tracked") return '<span class="sp-awaiting">No ' + esc(spLabel(prov)) + " ticket # yet</span>";
  if (t.awaiting === "you") return '<span class="sp-awaiting">' + esc(spLabel(prov)) + " replied</span>";
  return '<span class="sp-awaiting provider">Waiting on ' + esc(spLabel(prov)) + "</span>";
}

function spRefCell(t) {
  return (
    "<strong>" + esc(t.reference) + "</strong>" +
    (t.external_reference ? "<br /><small>#" + esc(t.external_reference) + "</small>" : "")
  );
}

/* ---------- Tickets view ---------- */

function showTicketsView() {
  const prov = provider;
  if (!enabled[prov]) return;
  SP.provider = prov;
  activeTab = "tickets";
  hideAllViews();
  const view = spEl("tickets-view");
  view.classList.remove("hidden");
  view.dataset.provider = prov;
  updateTabUi();
  spEl("sp-kicker").textContent = spLabel(prov);
  spEl("sp-title").textContent = spLabel(prov) + " support";
  spEl("sp-sub").textContent = "Loading…";
  spEl("sp-new").className = "primary" + spBtnClass(prov);
  spEl("sp-body").innerHTML = "";
  spEl("sp-wrap").classList.add("hidden");
  spEl("sp-stats").innerHTML = "";
  spSetStatus(spEl("sp-status"), "", "");
  spApplyCaps(prov).catch((err) => spSetStatus(spEl("sp-status"), "err", err.message));
  spLoadTickets().catch(() => {});
}

async function spApplyCaps(prov) {
  const caps = await spCaps(prov);
  if (SP.provider !== prov) return;
  const banner = spEl("sp-banner");
  spEl("sp-sev-head").textContent = caps.severity_label || "Severity";
  const awaitingChip = document.querySelector('#sp-filters [data-filter="awaiting"]');
  if (awaitingChip) {
    awaitingChip.dataset.label = caps.mode === "api" ? "Needs reply" : "Needs follow-up";
    awaitingChip.textContent = awaitingChip.dataset.label;
  }
  if (caps.mode === "api") {
    spEl("sp-sub").textContent =
      "Live from the " + caps.label + " API — read conversations, reply, close, and raise tickets without leaving Dropkick.";
    banner.classList.add("hidden");
  } else {
    spEl("sp-sub").textContent =
      "Dropkick drafts the ticket with live diagnostics, copies it, opens the " + caps.label +
      " support portal, and tracks it here with notes and status.";
    let html = "";
    if (caps.setup) {
      html =
        "<strong>Live " + esc(caps.label) + " ticket sync is off.</strong> " + esc(caps.setup.reason) +
        " Tickets are tracked in Dropkick until it is enabled:<ol>" +
        caps.setup.steps.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol>";
      banner.className = "sp-banner warn";
    } else {
      html =
        "<strong>" + esc(caps.label) + " has no ticket API.</strong> Raise the ticket here, paste it into the portal Dropkick opens, " +
        "then save the " + esc(caps.label) + " ticket number on the tracked ticket so the team can follow it.";
      banner.className = "sp-banner";
    }
    banner.innerHTML = html;
  }
}

async function spLoadTickets(force) {
  const prov = SP.provider;
  const token = ++SP.listToken;
  const qs = new URLSearchParams({ filter: SP.filter, q: spEl("sp-search").value.trim() });
  if (force) qs.set("refresh", "1");
  if (!spEl("sp-body").children.length) {
    spEl("sp-empty").textContent = "Loading tickets…";
    spEl("sp-empty").classList.remove("hidden");
  }
  try {
    const data = await spJson("/api/support/" + prov + "/tickets?" + qs);
    if (token !== SP.listToken || SP.provider !== prov) return;
    spSetStatus(spEl("sp-status"), "", "");
    spRenderStats(data.counts || {}, prov);
    spRenderTable(data, prov);
  } catch (err) {
    if (token !== SP.listToken) return;
    spSetStatus(spEl("sp-status"), "err", err.message);
    spEl("sp-empty").textContent = "Could not load tickets.";
    spEl("sp-empty").classList.remove("hidden");
  }
}

function spRenderStats(counts, prov) {
  const caps = SP.caps[prov] || {};
  const cards = [
    { f: "open", label: "Open", value: counts.open, hint: "Active tickets" },
    {
      f: "awaiting",
      label: caps.mode === "api" ? "Needs reply" : "Needs follow-up",
      value: counts.awaiting,
      hint: caps.mode === "api" ? spLabel(prov) + " replied last" : "No provider ticket # saved",
      attn: counts.awaiting > 0,
    },
    { f: "resolved", label: "Resolved", value: counts.resolved, hint: "Awaiting closure" },
    { f: "closed", label: "Closed", value: counts.closed, hint: "Closed or archived" },
  ];
  spEl("sp-stats").innerHTML = cards
    .map(
      (c) =>
        '<button type="button" class="sp-stat' + (c.attn ? " attn" : "") + (SP.filter === c.f ? " active" : "") +
        '" data-filter="' + c.f + '"><span>' + esc(c.label) + "</span><strong>" + esc(c.value == null ? "—" : c.value) +
        "</strong><small>" + esc(c.hint) + "</small></button>"
    )
    .join("");
  document.querySelectorAll("#sp-filters [data-filter]").forEach((chip) => {
    const f = chip.dataset.filter;
    chip.classList.toggle("active", f === SP.filter);
    const base = chip.dataset.label || chip.textContent.replace(/\s*\(\d+\)$/, "");
    chip.dataset.label = base;
    chip.textContent = counts[f] != null ? base + " (" + counts[f] + ")" : base;
  });
}

function spRenderTable(data, prov) {
  const rows = data.tickets || [];
  spEl("sp-body").innerHTML = rows
    .map((t) => {
      const r = t.resource;
      const server = r ? (r.ip ? r.ip + " · " : "") + (r.label || r.id || "") : "";
      return (
        '<tr data-ticket-ref="' + esc(t.reference) + '">' +
          '<td class="col-time">' + spRefCell(t) + "</td>" +
          '<td class="col-subj">' + esc(t.subject) + (server ? "<small>" + esc(server) + "</small>" : "") + "</td>" +
          '<td><span class="t-sev ' + esc(t.severity || "") + '" title="' + esc(t.severity_label) + '">' +
            esc(t.severity ? (t.source === "tracked" ? t.severity_label : t.severity) : "—") + "</span></td>" +
          "<td>" + ticketStatusPill(spStatusText(t)) + spAwaitingBadge(t, prov) + "</td>" +
          '<td class="col-time">' + esc(t.last_reply_by || "—") + "<br /><small>" + esc(relativeTime(t.updated_at)) + "</small></td>" +
          "<td>" + esc(t.opened_by || "—") + '<br /><small class="health-api">' + esc(formatLogTime(t.created_at)) + "</small></td>" +
        "</tr>"
      );
    })
    .join("");
  spEl("sp-wrap").classList.toggle("hidden", !rows.length);
  spEl("sp-empty").classList.toggle("hidden", Boolean(rows.length));
  if (!rows.length) {
    const caps = SP.caps[prov] || {};
    spEl("sp-empty").textContent =
      caps.mode === "tracked" && SP.filter === "open" && !(data.counts && data.counts.all)
        ? "No tracked tickets yet. Use Raise ticket to draft one with live diagnostics."
        : "No tickets match this filter.";
  }
  const caps = SP.caps[prov] || {};
  let line = "Showing " + rows.length + (data.matched > rows.length ? " of " + data.matched : "");
  if (caps.mode === "api") {
    line += " · indexed " + (data.scanned || 0);
    if (data.account_total) line += " of " + data.account_total + " on the account";
    if (caps.coverage) line += " (" + caps.coverage + ")";
  } else {
    line += " · " + (data.scanned || 0) + " tracked in Dropkick";
  }
  if (data.fetched_at) line += " · updated " + relativeTime(data.fetched_at);
  if (data.error) line += " · last error: " + data.error;
  spEl("sp-meta").textContent = line;
}

function spSetFilter(f) {
  SP.filter = f;
  spLoadTickets().catch(() => {});
}

spEl("sp-filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (chip) spSetFilter(chip.dataset.filter);
});
spEl("sp-stats").addEventListener("click", (e) => {
  const card = e.target.closest("[data-filter]");
  if (card) spSetFilter(card.dataset.filter);
});
spEl("sp-search").addEventListener("input", () => {
  clearTimeout(SP.searchTimer);
  SP.searchTimer = setTimeout(() => spLoadTickets().catch(() => {}), 300);
});
spEl("sp-refresh").addEventListener("click", () => {
  if (SP.provider) spCaps(SP.provider, true).then(() => spApplyCaps(SP.provider)).catch(() => {});
  spLoadTickets(true).catch(() => {});
});
spEl("sp-new").addEventListener("click", () => spOpenNew(SP.provider, {}));
spEl("sp-body").addEventListener("click", (e) => {
  const row = e.target.closest("[data-ticket-ref]");
  if (row) spOpenTicket(SP.provider, row.dataset.ticketRef);
});

/* ---------- Ticket conversation ---------- */

async function spOpenTicket(prov, ref) {
  SP.ticket = ref;
  SP.ticketProvider = prov;
  const backdrop = spEl("sp-ticket-backdrop");
  spEl("sp-t-title").textContent = ref;
  spEl("sp-t-meta").innerHTML = "";
  spEl("sp-t-tracked").classList.add("hidden");
  spEl("sp-t-thread").innerHTML =
    '<div class="health-box checking"><div class="spinner"></div><span>Loading conversation…</span></div>';
  spEl("sp-t-text").value = "";
  spEl("sp-t-compose").classList.add("hidden");
  ["sp-t-send", "sp-t-close", "sp-t-resolve", "sp-t-extlink"].forEach((id) => spEl(id).classList.add("hidden"));
  spSetStatus(spEl("sp-t-status"), "", "");
  spOpenOverlay(backdrop);
  try {
    const [data, caps] = await Promise.all([
      spJson("/api/support/" + prov + "/tickets/" + encodeURIComponent(ref)),
      spCaps(prov).catch(() => ({})),
    ]);
    if (SP.ticket !== ref) return;
    spRenderTicket(prov, data, caps);
  } catch (err) {
    if (SP.ticket !== ref) return;
    spEl("sp-t-thread").innerHTML = "";
    spSetStatus(spEl("sp-t-status"), "err", err.message);
  }
}

function spRenderTicket(prov, data, caps) {
  const t = data.ticket || {};
  const tracked = t.source === "tracked";
  SP.ticketData = data;
  spEl("sp-t-title").textContent = t.reference + " — " + (t.subject || "");
  const r = t.resource;
  spEl("sp-t-meta").innerHTML =
    "<span>Status " + ticketStatusPill(spStatusText(t)) + spAwaitingBadge(t, prov) + "</span>" +
    (t.severity ? '<span>' + esc(caps.severity_label || "Severity") + ' <strong class="t-sev ' + esc(t.severity) + '">' +
      esc((t.source === "tracked" ? t.severity_label : t.severity + " " + (t.severity_label || "")).trim()) + "</strong></span>" : "") +
    "<span>Opened by <strong>" + esc(t.opened_by || "—") + "</strong> · " + esc(formatLogTime(t.created_at)) + "</span>" +
    (r
      ? '<span style="flex-basis:100%">Server: <strong>' + esc((r.ip ? r.ip + " · " : "") + (r.label || r.id || "")) + "</strong>" +
        (r.ip ? ' <button type="button" class="ghost sp-x" data-open-server="' + esc(r.ip) + '">Open server</button>' : "") + "</span>"
      : "");

  const msgs = data.messages || [];
  spEl("sp-t-thread").innerHTML = msgs.length
    ? msgs
        .map((m) => {
          if (m.kind === "status" || m.kind === "reference") {
            return '<div class="sp-event">' + esc(m.from_name) + " · " + esc(m.body) + " · " + esc(relativeTime(m.date)) + "</div>";
          }
          const cls = m.kind === "description" ? "description" : m.is_staff ? "staff" : "";
          return (
            '<div class="sp-msg ' + cls + '">' +
              '<div class="sp-msg-head"><span><strong>' + esc(m.from_name || "—") + "</strong>" +
                (m.is_staff ? '<span class="sp-staff-badge">' + esc(spLabel(prov)) + "</span>" : "") +
                (m.kind === "note" ? ' <span class="sp-optional">note</span>' : "") +
              "</span><span>" + esc(formatLogTime(m.date)) + "</span></div>" +
              '<div class="sp-msg-body">' + esc(String(m.body || "").replace(/\r\n/g, "\n").trim()) + "</div>" +
              (m.attachments && m.attachments.length
                ? '<div class="reply-files">Attachments: ' + m.attachments.map((a) => esc(a.filename)).join(", ") + "</div>"
                : "") +
            "</div>"
          );
        })
        .join("")
    : '<p class="resource-note">No messages yet.</p>';
  const thread = spEl("sp-t-thread");
  thread.scrollTop = thread.scrollHeight;

  const trackedBox = spEl("sp-t-tracked");
  trackedBox.classList.toggle("hidden", !tracked);
  if (tracked) {
    spEl("sp-t-ref").value = t.external_reference || "";
    spEl("sp-t-state").value = t.status;
    spEl("sp-t-portal").href = caps.portal_url || "#";
  }

  const canReply = t.can_reply !== false;
  spEl("sp-t-compose").classList.toggle("hidden", !canReply);
  spEl("sp-t-send").classList.toggle("hidden", !canReply);
  spEl("sp-t-send").className = "primary" + spBtnClass(prov) + (canReply ? "" : " hidden");
  spEl("sp-t-send").textContent = tracked ? "Add note" : "Send reply";
  spEl("sp-t-text").placeholder = tracked
    ? "Add an internal note (e.g. what the provider said in the portal)…"
    : "Write a reply to " + spLabel(prov) + " support…";
  spEl("sp-t-quick").innerHTML = (tracked ? SP_QUICK_TRACKED : SP_QUICK_API)
    .map((q) => '<button type="button" data-quick="' + esc(q) + '">' + esc(q.length > 38 ? q.slice(0, 36) + "…" : q) + "</button>")
    .join("");
  spEl("sp-t-close").classList.toggle("hidden", !t.can_close || tracked);
  spEl("sp-t-resolve").classList.toggle("hidden", !t.can_resolve || tracked);
  const ext = spEl("sp-t-extlink");
  ext.classList.toggle("hidden", !t.ticket_url);
  if (t.ticket_url) ext.href = t.ticket_url;
  if (!canReply) {
    spSetStatus(spEl("sp-t-status"), "warn", "This ticket can no longer be changed. Raise a new ticket instead.");
  }
}

function spCloseTicketModal() {
  SP.ticket = null;
  spCloseOverlay(spEl("sp-ticket-backdrop"));
}

spEl("sp-t-x").addEventListener("click", spCloseTicketModal);

spEl("sp-t-quick").addEventListener("click", (e) => {
  const b = e.target.closest("[data-quick]");
  if (!b) return;
  const ta = spEl("sp-t-text");
  ta.value = ta.value.trim() ? ta.value.trim() + "\n\n" + b.dataset.quick : b.dataset.quick;
  ta.focus();
});

spEl("sp-t-meta").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open-server]");
  if (!b) return;
  const prov = SP.ticketProvider;
  const ip = b.dataset.openServer;
  spCloseTicketModal();
  if (activeTab !== prov) switchProvider(prov);
  ipInput.value = ip;
  getServerStatus(prov).catch(() => {});
});

async function spRefreshAfterChange(prov, ref) {
  await spOpenTicket(prov, ref);
  if (activeTab === "tickets" && SP.provider === prov) spLoadTickets().catch(() => {});
}

spEl("sp-t-send").addEventListener("click", async () => {
  const prov = SP.ticketProvider;
  const ref = SP.ticket;
  const text = spEl("sp-t-text").value.trim();
  const box = spEl("sp-t-status");
  const tracked = /^DK-/i.test(ref || "");
  if (!ref) return;
  if (!text) return spSetStatus(box, "err", tracked ? "Write a note first." : "Write a reply first.");
  if (!tracked) {
    const ok = await confirmAction({
      title: "Send reply to " + spLabel(prov) + "?",
      html: "This reply is posted to <strong>" + esc(ref) + "</strong> and is visible to " + esc(spLabel(prov)) + " support.",
      confirmLabel: "Send reply",
    });
    if (!ok) return;
  }
  const btn = spEl("sp-t-send");
  btn.disabled = true;
  spSetStatus(box, "info", tracked ? "Saving note…" : "Sending reply…");
  try {
    await spJson("/api/support/" + prov + "/tickets/" + encodeURIComponent(ref) + "/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: text }),
    });
    showToast("ok", tracked ? "Note added" : "Reply sent", ref, prov);
    await spRefreshAfterChange(prov, ref);
    spSetStatus(spEl("sp-t-status"), "ok", tracked ? "Note added." : "Reply sent.");
    loadLogs().catch(() => {});
  } catch (err) {
    spSetStatus(box, "err", err.message);
  } finally {
    btn.disabled = false;
  }
});

async function spPatch(prov, ref, body, okText) {
  const box = spEl("sp-t-status");
  spSetStatus(box, "info", "Saving…");
  try {
    await spJson("/api/support/" + prov + "/tickets/" + encodeURIComponent(ref), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showToast("ok", okText, ref, prov);
    await spRefreshAfterChange(prov, ref);
    spSetStatus(spEl("sp-t-status"), "ok", okText + ".");
    loadLogs().catch(() => {});
  } catch (err) {
    spSetStatus(box, "err", err.message);
  }
}

async function spConfirmState(action) {
  const prov = SP.ticketProvider;
  const ref = SP.ticket;
  const verb = action === "close" ? "Close" : "Resolve";
  const ok = await confirmAction({
    title: verb + " ticket " + ref + "?",
    html: "This updates the ticket on " + esc(spLabel(prov)) + " for everyone on the account.",
    confirmLabel: verb + " ticket",
    danger: action === "close",
  });
  if (ok) spPatch(prov, ref, { action }, action === "close" ? "Ticket closed" : "Ticket resolved");
}

spEl("sp-t-close").addEventListener("click", () => spConfirmState("close"));
spEl("sp-t-resolve").addEventListener("click", () => spConfirmState("resolve"));
spEl("sp-t-ref-save").addEventListener("click", () =>
  spPatch(SP.ticketProvider, SP.ticket, { reference: spEl("sp-t-ref").value.trim() }, "Ticket number saved")
);
spEl("sp-t-state").addEventListener("change", () =>
  spPatch(SP.ticketProvider, SP.ticket, { status: spEl("sp-t-state").value }, "Status updated")
);
spEl("sp-t-copy").addEventListener("click", async () => {
  const d = SP.ticketData;
  if (!d) return;
  const text = "Subject: " + d.ticket.subject + "\n\n" + (d.description || "");
  try {
    await navigator.clipboard.writeText(text);
    spSetStatus(spEl("sp-t-status"), "ok", "Ticket text copied — paste it into the provider portal.");
  } catch (_) {
    spSetStatus(spEl("sp-t-status"), "err", "Could not access the clipboard. Select the description above and copy it manually.");
  }
});

/* ---------- Server panel integration ---------- */

async function spLoadLinked(prov, ip, resourceId) {
  try {
    const qs = new URLSearchParams({ ip: ip || "" });
    if (resourceId != null) qs.set("resource_id", String(resourceId));
    const data = await spJson("/api/support/" + prov + "/linked?" + qs);
    return { state: "done", tickets: data.tickets || [], open: data.open || 0, error: data.error || null };
  } catch (err) {
    return { state: "done", tickets: [], open: 0, error: err.message };
  }
}

function spRenderLinked(support) {
  const label = spLabel(provider);
  let html =
    '<div class="linked-tickets"><h3><span>' + esc(label) + " tickets" +
    (support && support.state === "done" ? " (" + support.tickets.length + (support.open ? ", " + support.open + " open" : "") + ")" : "") +
    '</span><span class="modal-actions-right">' +
    '<button type="button" class="ghost" data-view-tickets="1">All tickets</button>' +
    '<button type="button" class="ghost" data-raise-ticket="1">Raise ticket</button></span></h3>';
  if (!support || support.state === "loading") {
    html += '<p class="resource-note">Looking for tickets linked to this server…</p>';
  } else if (support.error) {
    html += '<p class="resource-note">Could not load tickets: ' + esc(support.error) + "</p>";
  } else if (!support.tickets.length) {
    html += '<p class="resource-note">No tickets reference this server.</p>';
  } else {
    html += support.tickets.map(spTicketLine).join("");
  }
  return html + "</div>";
}

function spTicketLine(t) {
  return (
    '<div class="ticket-line" data-ticket-ref="' + esc(t.reference) + '">' +
      '<span class="t-ref">' + esc(t.reference) + "</span>" +
      ticketStatusPill(spStatusText(t)) +
      '<span class="t-subj" title="' + esc(t.subject) + '">' + esc(t.subject) + "</span>" +
      '<span class="t-meta">' + esc(t.last_reply_by || "—") + " · " + esc(relativeTime(t.updated_at)) + "</span>" +
    "</div>"
  );
}

function spRaiseForServer(prov, server) {
  const s = server || {};
  const h = (s._diag && s._diag.health) || {};
  const template = h.level === "down" ? "down" : s._diag && s._diag.maintenance && s._diag.maintenance.length ? "maintenance" : "other";
  spOpenNew(prov, {
    ip: s.ip || currentIp(),
    server: s._diag && s._diag.state === "done" ? s : null,
    linked: (s._diag && s._diag.support && s._diag.support.tickets) || [],
    template,
  });
}

/* ---------- Raise ticket ---------- */

function spServerSummary(prov, s) {
  if (!s) return "";
  const lines = ["IP: " + (s.ip || "—")];
  if (s.name) lines.push((prov === "digitalocean" ? "Droplet: " : prov === "linode" ? "Linode: " : "Instance: ") + s.name);
  if (s.id) lines.push("ID: " + s.id);
  if (s.region) lines.push("Region: " + s.region);
  if (s.size) lines.push("Plan: " + s.size);
  return lines.join("\n") + "\n\n";
}

function spDiagnostics(prov, s) {
  if (!s || !s._diag || s._diag.state !== "done") return "";
  const d = s._diag;
  const h = d.health || {};
  const probe = d.probe || { ports: [] };
  const lines = [
    "--- Diagnostics from Dropkick (" + new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC) ---",
    "Provider: " + spLabel(prov),
    h.api || "",
    "Health: " + (h.label || "?") + " — " + (h.message || ""),
    "Port check: " + probe.ports.map((p) => p.port + " " + (PORT_STATE_TEXT[p.state] || p.state)).join(", "),
  ];
  (d.maintenance || []).forEach((m) => lines.push("Maintenance: " + m.type + " " + m.status + " " + (m.when || "") + " — " + (m.reason || "")));
  return lines.filter(Boolean).join("\n");
}

function spFillTemplate(str, prov, s, ip) {
  return String(str)
    .replace(/\{ip\}/g, ip || "")
    .replace(/\{region\}/g, s && s.region ? " | " + s.region : "")
    .replace(/\{server\}/g, spServerSummary(prov, s) || (ip ? "IP: " + ip + "\n\n" : ""))
    .replace(/\s*\|\s*$/, "")
    .trim();
}

function spApplyTemplate(id) {
  const prov = SP.newProvider;
  const tpl = SP_TEMPLATES.find((t) => t.id === id) || SP_TEMPLATES[SP_TEMPLATES.length - 1];
  const caps = SP.caps[prov] || {};
  const ip = spEl("sp-n-ip").value.trim();
  const s = SP.newServer;
  document.querySelectorAll("#sp-n-templates [data-tpl]").forEach((b) => b.classList.toggle("active", b.dataset.tpl === tpl.id));
  let subject = spFillTemplate(tpl.subject, prov, s, ip);
  if (caps.subject_max) subject = subject.slice(0, caps.subject_max);
  spEl("sp-n-subject").value = subject;
  spEl("sp-n-desc").value = spFillTemplate(tpl.body, prov, s, ip) + "\n";
  const sev = spSeverityFor(caps, tpl.sev);
  if ([...spEl("sp-n-severity").options].some((o) => o.value === sev)) spEl("sp-n-severity").value = sev;
  SP.newTemplate = tpl.id;
  spUpdateCounter();
  spUpdateSevHint();
}

function spUpdateCounter() {
  const caps = SP.caps[SP.newProvider] || {};
  const n = spEl("sp-n-subject").value.length;
  spEl("sp-n-count").textContent = caps.subject_max ? n + " / " + caps.subject_max : "";
}

function spUpdateSevHint() {
  const sel = spEl("sp-n-severity");
  const opt = sel.options[sel.selectedIndex];
  spEl("sp-n-sev-hint").textContent = (opt && opt.dataset.desc) || "";
}

function spUpdateDiagPreview() {
  const text = spDiagnostics(SP.newProvider, SP.newServer);
  const on = spEl("sp-n-diag").checked && Boolean(text);
  spEl("sp-n-diag-wrap").classList.toggle("hidden", !text);
  spEl("sp-n-diag-preview").classList.toggle("hidden", !on);
  spEl("sp-n-diag-preview").textContent = text;
}

function spRenderNewServer(state) {
  const box = spEl("sp-n-server");
  if (!state) {
    box.innerHTML = "";
    return;
  }
  if (state.loading) {
    box.innerHTML = '<div class="sp-server-card"><div class="spinner"></div><span>Checking server and existing tickets…</span></div>';
    return;
  }
  if (state.error) {
    box.innerHTML = '<div class="sp-server-card err">' + esc(state.error) + "</div>";
    return;
  }
  const s = state.server;
  const h = (s._diag && s._diag.health) || {};
  let html =
    '<div class="sp-server-card"><strong>' + esc(s.name || s.id) + "</strong>" +
    '<span class="health-api">' + esc(s.ip) + (s.region ? " · " + esc(s.region) : "") + "</span>" +
    (h.label ? '<span class="pill ' + esc(h.level === "ok" ? "running" : h.level === "stopped" ? "stopped" : h.level) + '">' + esc(h.label) + "</span>" : "") +
    "</div>";
  const open = (state.linked || []).filter((t) => t.group === "open");
  if (open.length) {
    html +=
      '<div class="sp-dup"><strong>' + open.length + " open ticket(s) already reference this server.</strong> " +
      "Reply to an existing ticket instead of opening a duplicate:" +
      open.slice(0, 3).map(spTicketLine).join("") + "</div>";
  }
  box.innerHTML = html;
}

async function spCheckServer() {
  const prov = SP.newProvider;
  const ip = spEl("sp-n-ip").value.trim();
  const token = ++SP.checkToken;
  if (!ip) {
    SP.newServer = null;
    SP.newLinked = [];
    spRenderNewServer(null);
    spUpdateDiagPreview();
    return;
  }
  if (!/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip)) {
    spRenderNewServer({ error: "Enter a valid public IPv4 address, or leave it empty for an unlinked ticket." });
    return;
  }
  spRenderNewServer({ loading: true });
  try {
    const [diag, linked] = await Promise.all([
      spJson(PROVIDERS[prov].diagnosePath(ip)),
      spLoadLinked(prov, ip, null),
    ]);
    if (token !== SP.checkToken) return;
    const server = Object.assign({}, diag.instance, {
      _diag: { state: "done", health: diag.health, probe: diag.probe, maintenance: diag.maintenance },
    });
    const linked2 = server.id != null ? await spLoadLinked(prov, ip, server.id) : linked;
    if (token !== SP.checkToken) return;
    SP.newServer = server;
    SP.newLinked = linked2.tickets;
    spRenderNewServer({ server, linked: linked2.tickets });
    if (SP.newTemplate) {
      const desc = spEl("sp-n-desc").value;
      if (!desc.includes("IP: " + ip)) spApplyTemplate(SP.newTemplate);
    }
    spUpdateDiagPreview();
  } catch (err) {
    if (token !== SP.checkToken) return;
    SP.newServer = null;
    spRenderNewServer({ error: err.message });
    spUpdateDiagPreview();
  }
}

async function spOpenNew(prov, opts) {
  const o = opts || {};
  SP.newProvider = prov;
  SP.newServer = o.server || null;
  SP.newLinked = o.linked || [];
  SP.newTemplate = null;
  const backdrop = spEl("sp-new-backdrop");
  spEl("sp-n-title").textContent = "Raise " + spLabel(prov) + " ticket";
  spEl("sp-n-ip").value = o.ip || "";
  spEl("sp-n-subject").value = "";
  spEl("sp-n-desc").value = "";
  spEl("sp-n-diag").checked = true;
  spSetStatus(spEl("sp-n-status"), "", "");
  spEl("sp-n-templates").innerHTML = SP_TEMPLATES.map(
    (t) => '<button type="button" data-tpl="' + t.id + '">' + esc(t.label) + "</button>"
  ).join("");
  spEl("sp-n-submit").className = "primary" + spBtnClass(prov);
  spOpenOverlay(backdrop);

  let caps = {};
  try {
    caps = await spCaps(prov);
  } catch (err) {
    spSetStatus(spEl("sp-n-status"), "err", err.message);
  }
  const mode = spEl("sp-n-mode");
  if (caps.mode === "tracked") {
    mode.className = "sp-banner" + (caps.setup ? " warn" : "");
    mode.innerHTML =
      "<strong>" + esc(caps.label) + (caps.setup ? " live ticket sync is off." : " has no ticket API.") + "</strong> " +
      "Dropkick saves this ticket, copies the text, and opens the " + esc(caps.label) +
      " portal in a new tab — paste it there, then save the " + esc(caps.label) + " ticket number on the tracked ticket.";
    spEl("sp-n-submit").textContent = "Copy & open " + caps.label + " portal";
  } else {
    mode.className = "sp-banner hidden";
    spEl("sp-n-submit").textContent = "Create ticket";
  }
  spEl("sp-n-sev-label").textContent = caps.severity_label || "Severity";
  spEl("sp-n-severity").innerHTML =
    '<option value="">Not set</option>' +
    (caps.severities || [])
      .map((s) => '<option value="' + esc(s.value) + '" data-desc="' + esc(s.description || "") + '">' + esc(String(s.label).startsWith(s.value) ? s.label : s.value + " — " + s.label) + "</option>")
      .join("");
  spEl("sp-n-subject").maxLength = caps.subject_max || 250;

  if (SP.newServer) spRenderNewServer({ server: SP.newServer, linked: SP.newLinked });
  else spRenderNewServer(null);
  spApplyTemplate(o.template || "other");
  spUpdateDiagPreview();
  if (o.ip && !SP.newServer) spCheckServer().catch(() => {});
  spEl(o.ip ? "sp-n-desc" : "sp-n-ip").focus();
}

function spCloseNew() {
  SP.checkToken += 1;
  spCloseOverlay(spEl("sp-new-backdrop"));
}

spEl("sp-n-x").addEventListener("click", spCloseNew);
spEl("sp-n-cancel").addEventListener("click", spCloseNew);
spEl("sp-n-check").addEventListener("click", () => spCheckServer().catch(() => {}));
spEl("sp-n-ip").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    spCheckServer().catch(() => {});
  }
});
spEl("sp-n-ip").addEventListener("change", () => spCheckServer().catch(() => {}));
spEl("sp-n-templates").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tpl]");
  if (b) spApplyTemplate(b.dataset.tpl);
});
spEl("sp-n-subject").addEventListener("input", spUpdateCounter);
spEl("sp-n-severity").addEventListener("change", spUpdateSevHint);
spEl("sp-n-diag").addEventListener("change", spUpdateDiagPreview);
spEl("sp-n-server").addEventListener("click", (e) => {
  const line = e.target.closest("[data-ticket-ref]");
  if (!line) return;
  spCloseNew();
  spOpenTicket(SP.newProvider, line.dataset.ticketRef);
});

spEl("sp-n-submit").addEventListener("click", async () => {
  const prov = SP.newProvider;
  const caps = SP.caps[prov] || {};
  const box = spEl("sp-n-status");
  const ip = spEl("sp-n-ip").value.trim();
  const subject = spEl("sp-n-subject").value.trim();
  const severity = spEl("sp-n-severity").value;
  let description = spEl("sp-n-desc").value.trim();
  const diag = spDiagnostics(prov, SP.newServer);
  if (spEl("sp-n-diag").checked && diag) description += "\n\n" + diag;
  if (!subject || !spEl("sp-n-desc").value.trim()) return spSetStatus(box, "err", "Subject and description are required.");
  if (caps.subject_max && subject.length > caps.subject_max) {
    return spSetStatus(box, "err", "Subject is too long for " + caps.label + " (max " + caps.subject_max + ").");
  }
  const tracked = caps.mode === "tracked";

  let portalWin = null;
  if (tracked) {
    portalWin = window.open("about:blank", "_blank");
  } else {
    const ok = await confirmAction({
      title: "Create " + spLabel(prov) + " ticket?",
      html:
        "A real support ticket will be opened with " + esc(spLabel(prov)) + " on the shared account.<br /><br />" +
        "<strong>" + esc(subject) + "</strong>" +
        (ip ? "<br />Linked server: <code>" + esc(ip) + "</code>" : "<br />Not linked to a server") +
        (severity ? "<br />" + esc(caps.severity_label || "Severity") + ": " + esc(severity) : ""),
      confirmLabel: "Create ticket",
    });
    if (!ok) return;
  }

  const btn = spEl("sp-n-submit");
  btn.disabled = true;
  spSetStatus(box, "info", tracked ? "Saving tracked ticket…" : "Creating ticket…");
  try {
    const data = await spJson("/api/support/" + prov + "/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, subject, severity, description }),
    });
    if (tracked) {
      let copied = false;
      try {
        await navigator.clipboard.writeText("Subject: " + subject + "\n\n" + description);
        copied = true;
      } catch (_) {}
      if (portalWin && !portalWin.closed) portalWin.location.href = data.portal_url || caps.new_ticket_url;
      else window.open(data.portal_url || caps.new_ticket_url, "_blank");
      showToast(
        "ok",
        "Ticket tracked as " + data.reference,
        copied ? "Text copied — paste it into the " + caps.label + " portal." : "Open the ticket and use Copy ticket text.",
        prov
      );
    } else {
      showToast("ok", "Ticket created", (data.reference || "") + " — " + subject, prov);
    }
    spCloseNew();
    loadLogs().catch(() => {});
    if (activeTab === "tickets" && SP.provider === prov) spLoadTickets().catch(() => {});
    if (activeTab === prov && ip && currentIp() === ip) loadServerCard(ip, prov).catch(() => {});
    if (data.reference) {
      await spOpenTicket(prov, data.reference);
      if (tracked) {
        spSetStatus(
          spEl("sp-t-status"),
          "info",
          "Paste the ticket into the " + caps.label + " portal, then save the " + caps.label + " ticket number above."
        );
        spEl("sp-t-ref").focus();
      }
    }
  } catch (err) {
    if (portalWin && !portalWin.closed) portalWin.close();
    spSetStatus(box, "err", err.message);
  } finally {
    btn.disabled = false;
  }
});

[spEl("sp-ticket-backdrop"), spEl("sp-new-backdrop")].forEach((el) => {
  el.addEventListener("click", (e) => {
    if (e.target !== el) return;
    if (el.id === "sp-ticket-backdrop") spCloseTicketModal();
    else spCloseNew();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (spEl("modal-backdrop").classList.contains("show")) return;
  if (spEl("sp-new-backdrop").classList.contains("show")) spCloseNew();
  else if (spEl("sp-ticket-backdrop").classList.contains("show")) spCloseTicketModal();
});
