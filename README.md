# Dropkick

**Dropkick** is a dark-mode web app to **power cycle**, **stop**, and **start** cloud servers by public IPv4 on **DigitalOcean** and **Vultr**.

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
| `GET` | `/api/vultr/diagnose?ip=` | Vultr instance + TCP reachability (22/80/443) + health verdict + linked tickets |
| `GET` | `/api/vultr/tickets?filter=open\|resolved\|closed\|all&q=` | Search the newest 1,000 tickets (a reference lookup also reaches older ones) |
| `GET` | `/api/vultr/tickets/:reference` | Ticket details and replies |
| `POST` | `/api/vultr/tickets` | Body `{ "subject", "description", "severity"?, "ip"? }` — `ip` links the ticket to the instance |
| `POST` | `/api/vultr/tickets/:reference/replies` | Body `{ "description" }` |

## Vultr health and tickets

Vultr keeps reporting `active / running / ok` when the host node under an instance fails, so Dropkick also opens TCP connections to ports 22, 80, and 443 from its own server. If none answer, the instance is shown as **Unreachable** even though the API says running, and power cycle / start only report success once the server answers again (up to 4 minutes, then "not reachable").

The **Vultr tickets** tab lists, searches, and opens tickets, posts replies, and raises new tickets (optionally linked to an instance by IP). Ticket creation and replies are recorded in the operation log.

## Production (Cloudways)

Apache proxies to Node on `127.0.0.1:3000`. Set `HOST=127.0.0.1` in `.env`. Responses use `Cache-Control: no-store` so Varnish does not serve stale HTML.

If the UI looks old after deploy, hard-refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`).
