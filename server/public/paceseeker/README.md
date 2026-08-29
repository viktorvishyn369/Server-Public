# PaceSeeker

Self-custodial auto-trading for Solana. Simulate DEX and CEX arbitrage strategies risk-free in SIM mode, then optionally go LIVE with biometric-gated session keys. Your keys never leave your device.

## Strategies

### DEX Arbitrage
Scans Jupiter swap routes on Solana for USDC → Token → USDC round-trip opportunities across Raydium, Orca, Meteora, and other DEXes. Three execution modes:
- **Sandwich**: Two sequential transactions (swap1 confirms, then swap2 submits)
- **Atomic**: Both swaps bundled into one transaction via Jito — all-or-nothing execution
- **Auto**: Smart preset switching based on configured trading hours or market sentiment

### CEX Arbitrage
Monitors prices across 7 centralized exchanges (Bybit, OKX, MEXC, Gate.io, KuCoin, BingX, Bitget) for cross-exchange spreads. SIM mode uses public feeds; LIVE mode places real market orders via your API keys.

### DCA AI
AI-driven Dollar-Cost Averaging that accumulates a user-selected verified Solana token. Evaluates 13+ technical indicators (RSI, StochRSI, MACD, Bollinger Bands, EMA, Supertrend, ADX, OBV, chart patterns, Elliott Wave, momentum) across three timeframes (5m, 15m, 1H). Self-learns from every closed trade with adaptive weights and pattern memory. On-device price history dates back to 2020.

## Wallet Types

1. **Hardware Wallet / MWA** (Phantom, Solflare, Seed Vault) — manual approval for every trade
2. **Generated Session Key** — auto-signs trades, 24h expiry, revoke sweeps all funds back to owner
3. **Imported Private Key** — auto-signs trades from your own wallet, biometric-protected

## Fees

### DEX Trades
- Flat app fee: 0.01 USDC per completed trade (embedded in transaction, only moves if trade lands)
- Performance fee: 10% of net realized profit (winners only, above minProfitUsdc floor)
- Solana network fees: ~0.0000055–0.00014 SOL depending on preset and congestion
- Jito tip (Atomic mode only): 80K lamports default for Stable/Volatile, 0 for MaxTXs

### CEX Trades
- No PaceSeeker app fees. Exchange trading fees apply per exchange fee schedule.

### Vault Operations (Deposit, Withdraw, Swap)
- Zero PaceSeeker app fees. Solana network fees only (~0.000005 SOL per signature).

## Subscription

- **Price**: $20.00 USD/month (50% off with promo code)
- **Payment**: SOL, USDC, or SKR on Solana
- **Duration**: 30 days, no auto-renew
- **Unlocks**: Atomic mode, Auto mode, CEX LIVE trading, zero DEX app fees
- **When expired**: Reverts to Sandwich mode, CEX LIVE disabled, DEX app fees resume
- **SIM mode**: Always free

## Safety

- Daily loss cap (default $100 USDC, resets at midnight UTC)
- Consecutive loss stop (default 50)
- Market deterioration guard (aborts if expected return drops >15% post-swap1)
- Auto-sell recovery with escalating slippage (500→1000→2000 bps, up to 5 attempts)
- WSOL protection (never burned, auto-unwrapped)
- Transaction integrity verification before signing
- Native anti-tamper (root, debugger, Frida, Magisk detection)
- Remote config Ed25519 signature verification

## Presets

| Preset | Label | Use Case |
|--------|-------|----------|
| LowVolatile | Stable | Tight slippage, conservative gates |
| HighVolatile | Volatile | Wider slippage, higher priority fees |
| Max TXs | Max TXs | Maximum throughput, minimal profit per trade |

## Run

```bash
npm install
npm run start
```

## Important safety note

No app can honestly guarantee market profit. This code is designed around a safer rule: only submit candidate routes after simulation shows net profit after estimated gas, Jito tip, slippage, and commission. For production, final safety must be enforced by an atomic transaction/on-chain balance invariant so failed profit conditions revert.

## Tune Settings Reference

All settings are hot-applied — no restart needed. Settings are per execution mode (sandwich / atomic / auto) and per preset (maxTxs / lowVolatile / highVolatile). User edits to operational knobs (trade size, poll interval, cooldown, trade interval) are preserved across preset switches.

### Trade Execution Interval

| Setting | Unit | Default | Description |
|---|---|---|---|
| `minTradeIntervalSec` | seconds | 0 | Minimum seconds between executed trades. 0 = off. |
| `maxTradeIntervalSec` | seconds | 0 | Maximum seconds between executed trades. 0 = off. |

- **Both 0** → feature off, trades execute whenever profitable (default).
- **Both non-zero** → after each trade, profitable candidates are skipped until `min` seconds elapse. Between `min` and `max`, trades execute with increasing probability (randomized spreading). Past `max`, trades execute immediately. The interval resets after every trade, applying between each consecutive pair of trades.
- **Only one set** → alert shown in Tune UI: both must be set to enable, or both 0 to disable.
- **Min > max** → alert shown: min must be ≤ max.
- Works with all wallet types (session, hardware, imported private key) and all modes/presets.
- In auto mode, separate values are stored for atomic and sandwich execution paths (`atomicMinTradeIntervalSec` / `sandwichMinTradeIntervalSec` and their max counterparts). The Tune UI edits the active mode's values; `getEffectiveSettings` resolves the correct set per trade.

### Other Settings

| Setting | Unit | Default | Description |
|---|---|---|---|
| `minTradeUsdc` / `maxTradeUsdc` | USDC | 1 / 5 | Trade size range (randomized per tick). |
| `pollIntervalMs` | ms | 2,000 | Polling interval between scan cycles. |
| `tokenLossCooldownMs` | ms | 45,000 | Per-token cooldown after a losing trade. |
| `swapSlippageBps` | bps | 50 | Slippage tolerance for Jupiter swaps. |
| `maxSlippageBps` | bps | 150 | Maximum acceptable slippage for candidate evaluation. |
| `minProfitBps` | bps | 0 | Minimum profit threshold in basis points. |
| `minProfitUsdc` | USDC | 0 | Minimum profit threshold in USDC. |
| `computeUnitLimit` | CU | 1,000,000 | Compute budget per transaction. |
| `computeUnitPriceMicroLamports` | µlam/CU | 500 | Priority fee per compute unit. |
| `jitoTipLamports` | lamports | 0 | Jito tip for atomic bundle inclusion. |
| `feeBufferLamports` | lamports | 0 | Extra fee buffer for sandwich mode. |
| `cushionUsdc` | USDC | 0 | Flat USDC profit cushion subtracted from evaluation. |
| `minLiquidityUsd` | USD | 5,000 | Minimum pool liquidity for token inclusion. |
| `maxTokensPerTick` | tokens | 1 | Max tokens scanned per poll cycle. |
| `dailyLossCapUsdc` | USDC | 100 | Daily loss circuit breaker. |
| `maxConsecutiveLosses` | count | 50 | Consecutive loss circuit breaker. |
