# PhotoLynk — Photo & Video Backup with Digital Proof of Authenticity

> **⚠️ INTELLECTUAL PROPERTY NOTICE**  
> This repository is licensed under **CC BY-NC-ND 4.0**. The code, ideas, logic, algorithms, and implementation patterns are **proprietary intellectual property**. You may view and study the code, but you **MAY NOT** use any part of it (including concepts, logic, or algorithms) in commercial products, listings, or production systems without explicit written permission from Viktor Pavlyshyn (support@photolynk.io). See [LICENSE](LICENSE) for full terms.

PhotoLynk is a cross-platform mobile application for photo and video backup with built-in digital proof of authenticity. Back up your media to your own server or StealthCloud with end-to-end encryption, and create tamper-evident certificates for your photographs — complete with RFC 3161 trusted timestamps, C2PA provenance manifests, and EXIF integrity hashing.

[![Android](https://img.shields.io/badge/Platform-Android-3DDC84?style=flat&logo=android)](https://developer.android.com/)
[![iOS](https://img.shields.io/badge/Platform-iOS-000000?style=flat&logo=apple)](https://developer.apple.com/)
[![React Native](https://img.shields.io/badge/React_Native-0.76-61DAFB?style=flat&logo=react)](https://reactnative.dev/)
[![License](https://img.shields.io/badge/License-CC_BY--NC--ND_4.0-red)](LICENSE)

---

## Key Features

### Photo & Video Backup
- **End-to-End Encrypted**: XSalsa20-Poly1305 encryption before upload
- **Cross-Device Sync**: Android ↔ Desktop ↔ iOS
- **Zero-Knowledge Architecture**: Server never sees plaintext data
- **Self-Hosted or Cloud**: Local server, remote VPS, or StealthCloud

### Certify Original (Digital Proof of Authenticity)
- **One-Tap Certification**: Capture or select a photo and create a digital certificate
- **RFC 3161 Timestamps**: Trusted third-party proof via FreeTSA.org
- **C2PA Manifests**: Industry-standard Content Authenticity Initiative provenance
- **4-Layer EXIF Hashing**: Content, raw EXIF, normalized EXIF, binding hash
- **Tamper-Evident**: SHA-256 cryptographic fingerprints for every certificate

### Certificate of Authenticity
- **Permanent Digital Proof**: All hashes and timestamps stored in the certificate
- **Verifiable by Anyone**: No PhotoLynk account needed to verify
- **Offline Verification**: Export certificate, verify via standard command-line tools

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    PhotoLynk Mobile App                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Camera     │  │ Certification│  │ Certificate  │  │
│  │  Capture     │→ │   Engine     │→ │   Viewer     │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│         ↓                  ↓                  ↑          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ EXIF Extract │  │  Biometric   │  │ StealthCloud │  │
│  │  (Native)    │  │    Auth      │  │    Backup    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                          ↓
         ┌────────────────┴────────────────┐
         ↓                                  ↓
┌──────────────────┐            ┌──────────────────┐
│ Certificate Store│            │  FreeTSA.org     │
│ (Digital Proofs) │            │  (RFC 3161 TSA)  │
└──────────────────┘            └──────────────────┘
```

### Tech Stack
- **Frontend**: React Native 0.76, Expo SDK 52
- **Crypto**: NaCl (TweetNaCl.js), SHA-256 (js-sha256)
- **Native Modules**: Swift (iOS), Kotlin (Android) for EXIF extraction
- **Backend**: Node.js server for certification orchestration

---

## Getting Started

### Prerequisites
- Android 10+ (API 29+) or iOS 15+
- Network access (Wi-Fi or cellular)

### Installation

PhotoLynk is available on the App Store and Google Play:

- **iOS**: [Download on the App Store](https://apps.apple.com/app/id6748285696)
- **Android**: [Download on Google Play](https://play.google.com/store/apps/details?id=com.photosync.app)

### Development Setup

```bash
# Clone repo
git clone <repository-url>
cd PhotoLynk

# Install dependencies
npm install

# Create .env file with your own API keys (not included in repo)
cp .env.example .env
# Edit .env and add your keys

# Run on Android
npx expo run:android

# Run on iOS
npx expo run:ios
```

> **Note:** The `.env` file is gitignored and never included in the repository. You must create your own. See `.env.example` for required keys.

---

## User Flow

### 1. Back Up Photos & Videos
```
Select Photos → Encrypt on Device → Upload to StealthCloud or Local Server
```

### 2. Certify Original
```
Select Photo → Tap "Certify Original" → Biometric Auth
              ↓
Cryptographic Hashing + RFC 3161 Timestamp
              ↓
Certificate Generated & Saved
```

### 3. View Certificate
```
Certificates Tab → Select Photo → View Details
                                    ↓
                    ┌───────────────┴───────────────┐
                    ↓                               ↓
            Proof Details                   Verification Commands
            • Content Hash                  • OpenSSL verify RFC 3161
            • EXIF Hashes (4x)             • FreeTSA.org verification
            • RFC 3161 Token               • SHA-256 hash check
            • C2PA Manifest
```

---

## In-App Purchases

PhotoLynk offers two optional in-app purchases:

### Subscriptions — Monthly or Yearly (SOL or SKR)
- 100 GB — $1.75/mo
- 200 GB — $2.45/mo
- 400 GB — $3.99/mo
- 1 TB — $7.99/mo
- Yearly billing = monthly price × 12
- Paid via Solana wallet (SOL or SKR token)
- 7-day free trial available

### Premium — $49.99 USD (One-Time)
- Unlocks 1 TB of end-to-end encrypted cloud storage for 1 year
- Includes 100 free Web3 Album additions (no app commission, no network fees)
- Beyond 100: flat $0.01 USDC per mint, up to 10,000 total additions
- After 10,000: regular mint fees apply with any active loyalty or subscriber discounts
- Full access across all platforms and devices linked to your account
- One-time payment — no recurring charges, no auto-renewal
- Paid via Solana wallet (SOL or SKR token)

### Web3 Album Mint Fees
- Base commission: $0.15 for files up to 3 MB, +10% per additional MB
- Subscribers (any active paid plan): 80% off mint fees
- Loyalty discounts accumulate weekly, up to 80% off commission
- Solana network fees are separate and always paid in SOL

### Grace Period
- Lapsed subscriptions get a 3-day read-only window to download everything
- No uploads or edits, no auto-deletions
- Certificates remain user-owned via on-device keys

All Solana payments are processed on-chain. PhotoLynk does not directly handle payment card information. Purchases are final and non-refundable except as required by applicable law.

---

## Security & Privacy

### Photo Privacy
- **End-to-End Encryption**: StealthCloud backup is E2E encrypted (XSalsa20-Poly1305)
- **Local-First**: Photos stay on device unless you back up
- **Zero-Knowledge**: Server never sees plaintext images

### Authentication
- **Biometric Auth**: Fingerprint / Face ID for sensitive operations
- **Device Binding**: JWT tokens bound to specific device identifiers
- **Secure Storage**: iOS Keychain / Android Keystore for credentials

### API Key Management
- **No Hardcoded Secrets**: All API keys via environment variables
- **Server-Side Operations**: Sensitive keys on backend only

---

## EXIF Hash Proof System

When certifying a photo, PhotoLynk computes a 3-hash cryptographic proof:

| Hash | Description | Purpose |
|------|-------------|---------|
| **Hash 1** (Raw EXIF) | SHA-256 of raw EXIF binary bytes (thumbnails stripped) | Proves exact camera output |
| **Hash 2** (Normalized EXIF) | SHA-256 of parsed, normalized, sorted EXIF fields | Cross-platform verification |
| **Hash 3** (Binding) | SHA-256(Hash1 \| Hash2) | Cryptographically binds raw and normalized proofs |

Additional integrity proofs:
- **Content Hash**: SHA-256 of original file bytes
- **Camera Serial Hash**: SHA-256 of camera body serial number
- **RFC 3161 Timestamp**: Trusted third-party timestamp proving existence at certification time
- **C2PA Manifest**: Content Authenticity Initiative provenance data

---

## Contributing

Bug reports and feature suggestions are welcome via GitHub Issues.

This project is licensed under CC BY-NC-ND 4.0. Pull requests may be accepted at the maintainer's discretion, but you may not distribute modified versions independently. See [LICENSE](LICENSE).

---

## Legal Documentation

Policy files for the Solana Mobile dApp Store, App Store, and Google Play Store are located in the `public/` folder:

| Document | Path | Hosted URL |
|----------|------|------------|
| Terms of Service | `public/terms.html` | `https://your-domain.com/solana-seeker/terms.html` |
| Privacy Policy | `public/privacy-policy.html` | `https://your-domain.com/solana-seeker/privacy-policy.html` |

These files include Solana-specific disclosures for blockchain payments, NFT minting, and wallet security. They must be deployed to a publicly accessible web server for dApp store compliance. Update the URLs in `app.json` and your store listing configuration to point to your deployed location.

---

## License

**CC BY-NC-ND 4.0** (Creative Commons Attribution-NonCommercial-NoDerivatives)

- View and study source code
- Share repository link
- No commercial use without permission
- No building/distributing applications without permission
- No modified versions

**Commercial use requires written permission**: support@photolynk.io

See [LICENSE](LICENSE) file for full terms.

---

## Links

- **Website**: [photolynk.io](https://photolynk.io)
- **Demo Video**: [Watch on YouTube](https://youtu.be/FNTu4fUd6y8)
- **FreeTSA Verification**: [freetsa.org](https://freetsa.org/)

---

## Contact

**Viktor Pavlyshyn**  
**Email**: support@photolynk.io

---

**Your photos, your proof, your privacy.**
