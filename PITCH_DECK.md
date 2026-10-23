# PhotoLynk
## Camera-to-On-Chain Authenticity Proof

**Team**: Viktor Pavlyshyn

---

# The Problem

## Authenticity and provenance are hard to prove from mobile workflows

- Photos can be copied, reposted, or altered after capture
- Metadata alone is not enough for strong provenance claims
- Most on-chain mint flows are not designed around camera-originated photo evidence
- Mobile users need a simpler certify flow than desktop-first mint tooling

---

# The Solution

## PhotoLynk adds a mobile-first certification flow for original photos

### Camera → Certify in a short mobile flow

1. 📸 **Capture or choose** a photo
2. ✍️ **Add** name and details
3. ✅ **Certify** with wallet approval

**Result**: an on-chain certification record anchored to the photo and its proof data

**Estimated cost per certification**: depends on:

- current on-chain network fees
- storage option selected
- file size
- PhotoLynk app commission

In the current mint service code, the total estimate is calculated as:

- **network fee**
- **storage upload cost**
- **size-based app commission**

The current regular size-based app commission starts at **$0.72 USD** for files up to **3 MB**, then increases by **10% of the base per additional MB above 3 MB**. Promotional pricing may temporarily lower the displayed fee, but the product should be described as an **estimated total cost**, not as a fixed sub-cent mint.

---

# Technical Architecture

```
┌─────────────────────────────────────┐
│       PhotoLynk Mobile App          │
│  Photo selection → proof → certify  │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│      Mobile wallet approval         │
│   Secure transaction confirmation   │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│      On-chain certification         │
│   Compressed mint / proof anchor    │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│    Cryptographic proof material     │
│   RFC 3161 + C2PA + EXIF hashing    │
└─────────────────────────────────────┘
```

**Current implementation includes**:

- the base mobile Solana app code used across the mobile variants
- mobile wallet approval flow
- `server/` backend code
- `server-tray/` desktop/server code for certification and restore flows

---

# Cryptographic Proof Stack

## Proof material tracked by the current codebase

### 🔐 RFC 3161 timestamps

- RFC 3161 timestamp support exists in the certification flow
- Timestamp data is intended to provide third-party time attestation

### 📜 C2PA provenance data

- C2PA manifest/provenance support exists in the certification model

### 🔢 Multi-layer image and EXIF hashing

- **Content Hash**: SHA-256 of original file bytes
- **Raw EXIF Hash**: SHA-256 of raw EXIF bytes when present
- **Normalized EXIF Hash**: SHA-256 of normalized EXIF fields
- **Binding Hash**: SHA-256 binding of raw and normalized EXIF hashes

These proof fields are documented in the repository and are part of the certification security model.

---

# Cost Model

## Use estimated totals, not fixed mint slogans

The current certification pricing logic computes total cost from:

- **network cost**
- **storage cost**
- **app commission**

### Current regular commission logic

- Base app commission: **$0.72 USD**
- Applies to files up to **3 MB**
- Each additional MB above 3 MB adds **+10%** to the base commission

### Current storage estimate logic

- Metadata upload estimate uses a base upload cost plus a per-KB component
- External storage options add image upload cost on top of metadata upload cost
- On-chain storage mode estimates metadata upload cost separately

### Pricing statement that matches the code

PhotoLynk certifications should be described as:

> **Estimated total cost per certification, based on live on-chain fees, storage choice, file size, and PhotoLynk commission.**

---

# Product Characteristics

## What the current implementation supports

- Mobile certification flow with wallet approval
- Photo metadata extraction and preservation across mobile and desktop paths
- On-chain certification flow with compressed minting logic
- Redundant certificate storage across StealthCloud and IPFS to improve resilience, availability, and faster asset loading
- Repository-level documentation for EXIF, IPTC, XMP, RFC 3161, and C2PA related handling

---

# Current Status

## What can be stated directly from the repository

- The repository contains:
  - `server/` backend code
  - `server-tray/` desktop/server app code
  - the base mobile Solana app code that the mobile variants are built from
- Additional mobile source is not included here due to licensing restrictions
- Wallet-related certification flows are implemented in the mobile base app
- Demo video and documentation are present in the repository

---

# Team

## Viktor Pavlyshyn
**Founder / Developer**

- React Native mobile development
- Node.js backend development
- photo backup, metadata, and certification workflows

### Contact

- **Email**: support@photolynk.io
- **GitHub**: @viktorvishyn369
- **x.com**: @StealthLynkIO
- **Telegram**: @StealthLynkIO

---

# Call to Action

## Explore PhotoLynk

- Review the source code in this repository
- Review the product documentation in `README.md`
- Watch the demo video: https://youtu.be/FNTu4fUd6y8

---

# Links

- **Demo Video**: https://youtu.be/FNTu4fUd6y8
- **Pitch Deck**: https://github.com/viktorvishyn369/PhotoLynk/blob/main/PITCH_DECK.md
- **FreeTSA**: https://freetsa.org
- **Website**: https://stealthlynk.io

---

**PhotoLynk**
