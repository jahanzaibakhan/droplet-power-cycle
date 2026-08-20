# Droplet Power Cycle

Dark-mode web app to **power cycle**, **stop**, and **start** DigitalOcean droplets by public IPv4. Uses DigitalOcean’s `power_cycle` action (hard reset), not graceful `reboot`.

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

## Production (Cloudways)

Apache proxies to Node on `127.0.0.1:3000`. Set `HOST=127.0.0.1` in `.env`. Responses use `Cache-Control: no-store` so Varnish does not serve stale HTML.

If the UI looks old after deploy, hard-refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`).
