# Dropkick

**Dropkick** is a dark-mode web app to **power cycle**, **stop**, and **start** cloud servers by public IPv4 on **DigitalOcean**, **Vultr**, and **Linode**, with health checks and provider support tickets.

The API token stays in server `.env` only — never sent to the browser.

## Prerequisites

- Node.js 18+
- DigitalOcean personal access token with **read + write** scope  
  [Create a token](https://cloud.digitalocean.com/account/api/tokens)

## Setup

```bash
npm install
cp .env.example .env
# edit .env → DIGITALOCEAN_API_TOKEN=dop_v1_...
npm start
```

Open [http://localhost:3000](http://localhost:3000). Version is shown in the footer (`GET /api/version`).

## Actions

| UI button   | DO API action   |
|------------|-----------------|
| Power cycle | `power_cycle`  |
| Stop        | `power_off`    |
| Start       | `power_on`     |

Large accounts: droplet IPs are indexed in the background; type a name or IP to search. Lookup by IP uses reverse DNS + DO name filter so you do not wait for the full cache.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/version` | App version |
| `GET` | `/api/droplet?ip=` | Live droplet status |
| `POST` | `/api/action` | Body `{ "ip", "action": "power_cycle"|"stop"|"start" }` |
| `GET` | `/api/action-status/:id?droplet_id=` | Poll action status |
| `GET` | `/api/droplet/diagnose?ip=` | Droplet + TCP reachability (22/80/443) + health verdict |
| `GET` | `/api/linode/diagnose?ip=` | Linode + TCP reachability + health verdict + scheduled/in-progress maintenance |
| `GET` | `/api/vultr/diagnose?ip=` | Vultr instance + TCP reachability (22/80/443) + health verdict + linked tickets |
| `GET` | `/api/support/:provider/capabilities` | Ticket mode (`api` or `tracked`), severities, subject limit, portal links, Linode setup steps |
| `GET` | `/api/support/:provider/tickets?filter=open\|awaiting\|resolved\|closed\|all&q=&refresh=1` | Ticket list with counts per filter |
| `GET` | `/api/support/:provider/linked?ip=&resource_id=` | Tickets that reference a server |
| `GET` | `/api/support/:provider/tickets/:reference` | Ticket details and conversation |
| `POST` | `/api/support/:provider/tickets` | Body `{ "subject", "description", "severity"?, "ip"? }` — `ip` links the ticket to the server |
| `POST` | `/api/support/:provider/tickets/:reference/replies` | Body `{ "description" }` (a note on tracked tickets) |
| `PATCH` | `/api/support/:provider/tickets/:reference` | Body `{ "action": "close"\|"resolve" }`, or for tracked tickets `{ "status", "reference" }` |

`:provider` is `vultr` or `linode`. DigitalOcean has no ticket API, so it has no tickets option.

## Health checks and tickets

No provider API reports a failed host node — DigitalOcean says `active`, Linode `running`, Vultr `active / running / ok`. On every lookup Dropkick also opens TCP connections to ports 22, 80, and 443 from its own server. If none answer, the server is shown as **Unreachable** even though the API says running, and power cycle / start only report success once the server answers again (up to 4 minutes, then "not reachable"). Linode servers also show scheduled or in-progress platform maintenance from `/account/maintenance`.

Vultr and Linode each have a **tickets** tab (shown next to its server tab) and a tickets section in the server panel:

| Provider | Mode | What works |
|----------|------|------------|
| Vultr | Live API | List, search, read, reply, resolve, close, raise |
| Linode | Live API when `LINODE_SUPPORT_TOKEN` (or `LINODE_API_TOKEN`) has **Account: Read/Write** | List, search, read, reply, close, raise. Without that scope, Linode falls back to tracked mode: Dropkick saves the ticket, copies the text, opens the Linode portal, and tracks the ticket number, status, and notes, with setup steps shown |

Raising a ticket checks the server first (health, port check, maintenance), warns about open tickets already linked to it, offers issue templates with a matching severity, and can append the live diagnostics to the description. Tracked tickets are stored in MySQL (`tracked_tickets`, `tracked_ticket_events`). Every ticket action is recorded in the operation log.

## Production (Cloudways)

Apache proxies to Node on `127.0.0.1:3000`. Set `HOST=127.0.0.1` in `.env`. Responses use `Cache-Control: no-store` so Varnish does not serve stale HTML.

If the UI looks old after deploy, hard-refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`).
