# StealthLynk — Self-Hosted Server & Desktop Tray

Public self-hosting bundle for the StealthLynk ecosystem. Run your own backup
server, keep every byte under your control, and connect the mobile apps to your
own infrastructure instead of (or alongside) StealthCloud.

## The Ecosystem

| App | What it does |
|---|---|
| **PhotoLynk** | Photo & video backup with bit-for-bit storage, end-to-end encryption, digital authenticity certificates (RFC 3161 timestamps, C2PA provenance, 4-layer EXIF hashing), and an optional Solana cNFT Web3 album |
| **PaceSeeker** | AI-assisted DCA trading with on-device strategy learning |
| **Lane** | Avatar/profile companion app for the ecosystem |
| **PhotoLynk Desktop Tray** | The desktop app in this repo — runs your own local server |
| **StealthCloud** | Managed zero-knowledge cloud (alternative to self-hosting) |

## What's in this repository

| Path | Contents |
|---|---|
| `remote-server/` | **PhotoLynk Remote Server** — headless Node.js backup server for your own VPS. Source-auditable, no NFT/payment/telemetry code. |
| `server-tray/` | PhotoLynk Desktop Tray — Electron app that runs a backup server on your own machine (macOS/Windows/Linux): sync, backups, NFT minting, wallet connect |
| `server/public/` | Public pages served by StealthLynk servers — landing page and per-app pages for PhotoLynk, PaceSeeker and Lane |
| `install.sh` | One-line installer for the Remote Server (interactive domain + HTTPS setup) |
| `docs/` | Policy documents: privacy policy, terms, license, copyright, delete-account instructions |
| `security/` | Security audit report and audit script |
| `LICENSE` | CC BY-NC-ND 4.0 |

## Self-hosting — pick your server

PhotoLynk offers three server modes in the app (**Settings → Server**):

| Mode | Where files live | Encryption | Best for |
|---|---|---|---|
| **StealthCloud** | StealthLynk managed cloud | End-to-end, zero-knowledge | Zero setup, strongest privacy |
| **Remote** *(this repo)* | **Your VPS** behind your domain + HTTPS | Unencrypted at rest on *your* disk, TLS in transit | Always-on access from anywhere, you own the hardware |
| **Local** | Your own computer/desktop tray on the LAN | Unencrypted, plain HTTP on your network | Free, offline, same-household use |

### Remote Server — one line on your VPS

You bring a VPS (any Ubuntu/Debian host) and a domain. The script does the
rest — Node.js, dependencies, systemd service, and optional Nginx + Let's
Encrypt HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/Server-Public/main/install.sh | sudo bash
```

The installer asks for your domain and email, configures everything, and prints
the exact address to enter in the app. Re-running it updates the server.

Then in PhotoLynk: **Settings → Server → Remote** → enter your domain
(e.g. `photos.example.com` — no `https://`, no port).

**What the Remote Server is:** `remote-server/server.js` — a single auditable
Node.js file (~4k lines) implementing the exact API the app speaks: register /
login (JWT, device-bound), raw binary uploads, SHA-256 + perceptual-hash
deduplication, thumbnails, EXIF sidecars, multi-device sync, account deletion.

**What it is not:** there is no NFT minting, no payments, no analytics, no
phone-home, no telemetry. The only outbound call is an optional IP→country
lookup that is disabled by default. Read the source — that is the point.

Manual setup is also documented in [`remote-server/README.md`](remote-server/README.md)
if you prefer Docker, a different init system, or your own TLS termination.

### Easiest: the desktop tray (Local mode)

`server-tray/` is a self-contained Electron app — it bundles a full backup
server in your menubar/system tray. Install dependencies, start it, and point
the mobile apps at your machine:

```bash
cd server-tray
npm install
npm start
```

Your server then handles backups, sync, and certificates locally — nothing
leaves your network unless you let it.

## Security model

- **You choose the trust boundary** — StealthCloud encrypts on-device
  (zero-knowledge); Remote/Local store files unencrypted on infrastructure
  *you* control, protected in transit by TLS (Remote) or your LAN (Local)
- **Bit-for-bit integrity** — originals stored without recompression; SHA-256
  fingerprints on every file
- **Tamper-evident provenance** — RFC 3161 trusted timestamps, C2PA manifests,
  and 4-layer EXIF hashing detect any modification
- **Device-bound sessions** — JWTs are bound to a device UUID; a token copied
  to another device is rejected
- **Per-install secrets** — the Remote Server generates a unique JWT secret on
  first boot; no shared keys between installations
- **Graceful degradation** — local-first design: apps keep working offline and
  reconcile when the server returns

## Policies

- [Privacy Policy](docs/privacy-policy.html)
- [Terms](docs/terms.html)
- [License](docs/license.html)
- [Delete Account](docs/delete-account.html)
- [Copyright](docs/copyright.html)

Per-app public pages live under `server/public/`.

## Links

- Website: [stealthlynk.io](https://stealthlynk.io)
- Ecosystem overview: [github.com/viktorvishyn369](https://github.com/viktorvishyn369)
