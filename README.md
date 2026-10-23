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
| `server-tray/` | PhotoLynk Desktop Tray — Electron app that runs a backup server on your own machine (macOS/Windows/Linux): sync, backups, NFT minting, wallet connect |
| `server/public/` | Public pages served by StealthLynk servers — landing page and per-app pages for PhotoLynk, PaceSeeker and Lane |
| `docs/` | Policy documents: privacy policy, terms, license, copyright, delete-account instructions |
| `LICENSE` | CC BY-NC-ND 4.0 |

## Self-hosting

### Easiest: the desktop tray

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

### On a VPS / always-on machine

The tray app runs anywhere Node + a desktop environment is available. For a
headless VPS deployment, use your usual tooling (systemd user service,
remote desktop session, or a container with a virtual display) to keep the
tray running, then open your chosen port. The mobile apps accept any
server URL — your Pi, your NAS, or a VPS anywhere in the world.

## Security model

- **Zero-knowledge storage** — media is encrypted on-device before upload; the
  server never sees plaintext or keys
- **On-device keys** — certificates, wallet operations and NFT transfers are
  signed on the device; private keys never touch the server
- **Bit-for-bit integrity** — originals stored without recompression; SHA-256
  fingerprints on every certificate
- **Tamper-evident provenance** — RFC 3161 trusted timestamps, C2PA manifests,
  and 4-layer EXIF hashing detect any modification
- **User-owned NFTs** — Web3 album items are minted to the *user's* wallet; the
  service pays minting fees but never holds ownership
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
