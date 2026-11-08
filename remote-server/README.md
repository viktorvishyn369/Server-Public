# PhotoLynk Remote Server

Self-hosted backup server for the PhotoLynk app. Run it on your own VPS, point
your domain at it, and choose **Remote** in the app's server settings. Your
photos and videos live on *your* disk — this server contains no NFT, payment,
analytics, or telemetry code.

## Quick start (VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/Server-Public/main/install.sh | sudo bash
```

The installer asks for your domain, installs Node.js + dependencies, creates a
systemd service, and optionally configures Nginx + Let's Encrypt HTTPS. See
[`../install.sh`](../install.sh).

## Manual run

```bash
cd remote-server
npm install
node server.js
```

Listens on `0.0.0.0:3000` by default (`PORT`, `HOST` env vars). Put it behind
Nginx/Caddy/Cloudflare Tunnel for TLS — the app expects `https://your-domain`
on port 443 for domain hosts.

## Configuration

See [`.env.example`](.env.example). Everything is optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `UPLOAD_DIR` | `<data>/uploads` | Where media files are stored (per-device folders) |
| `DB_PATH` | `<data>/backup.db` | SQLite database (users, devices, hashes, EXIF) |
| `PHOTOSYNC_DATA_DIR` | parent of `UPLOAD_DIR` | Cloud manifests, EXIF, capacity + uptime state |
| `JWT_SECRET` | auto-generated | Session signing secret — generated per install under `~/.config/photolynk/` |
| `ENABLE_HTTPS` + `TLS_*` | off | Built-in TLS instead of a reverse proxy |

## API surface (what the app calls)

| Endpoint | Purpose |
|---|---|
| `POST /api/register`, `POST /api/login` | Account + device-bound JWT (30d) |
| `POST /api/upload/raw` | Binary upload (`X-Filename`, `X-Perceptual-Hash` headers) |
| `GET /api/files?meta=true` | Paginated file list with hashes |
| `GET /api/files/:name`, `…/thumb` | Download + thumbnail |
| `POST /api/exif/*`, `GET /api/exif/:hash` | EXIF metadata sidecars |
| `POST /api/files/platform-hash(es)` | Cross-device dedup hashes |
| `POST /api/files/purge`, `DELETE /api/account` | Delete all / account (GDPR) |
| `GET /api/cloud/usage` | Quota/usage probe (called on every login) |
| `GET /api/health`, `/api/capacity` | Health + capacity |
| `POST /api/device/link(s)` | Multi-device QR pairing |
| `POST /api/auth/*`, `/api/reset-password-device`, `/api/migrate-credentials` | Password reset & credential migration |

Auth: `Authorization: Bearer <jwt>` + `X-Device-UUID` on every call. Tokens are
bound to the device UUID they were issued for.

## Security notes

- Files are stored **unencrypted** on your disk (same model as Local mode) —
  protect the VPS accordingly. TLS encrypts everything in transit.
- Password-reset codes are written to the server log (`journalctl -u
  photolynk-remote`) — there is no email integration by design.
- Rate limiting on auth endpoints is built in (in-memory, per-IP).
- The only optional outbound call is an IP→country lookup used by the
  (disabled-by-default) country-verification flow.

## Layout

```
remote-server/
├── server.js          # the whole server — read it, it's the audit
├── package.json
├── .env.example
└── public/index.html  # minimal landing/status page at /
```
