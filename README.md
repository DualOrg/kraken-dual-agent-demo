# DUAL x Kraken Agent Trading Passport

A safe partner-demo repo that shows Kraken as the agent execution venue and DUAL as the policy, approval, and audit layer.

The public MVP runs in paper/simulator mode by default:

- Kraken CLI market data if `kraken` is installed.
- Kraken public market-data API when Kraken CLI is unavailable.
- Simulator fallback only when both Kraken CLI and Kraken public API are unavailable.
- Kraken spot paper trade command path when available.
- DUAL `agent_trading_passport` lifecycle simulated locally with the same object model expected for a DUAL-backed integration.
- Red-team scenarios that prove unsafe requests are blocked before execution.
- Optional DUAL persistence adapter for syncing passport/audit lifecycle to DUAL when credentials are configured.

## Run

```bash
npm start
```

Open <http://localhost:4173>.

## Test

In one terminal:

```bash
npm start
```

In another:

```bash
npm test
```

## Kraken CLI Integration

Install Kraken CLI separately when ready:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh
```

The adapter targets the documented safe commands:

```bash
kraken ticker BTCUSD -o json
kraken paper init --balance 10000 -o json
kraken paper buy BTCUSD 0.01 -o json
```

If the binary is missing or returns an error, the app falls back to Kraken's public ticker API for market data. It uses deterministic simulated data only if both CLI and public API are unavailable.

## DUAL Persistence

By default the demo uses local persistence. To sync lifecycle events to real DUAL objects, configure:

```bash
DUAL_PERSISTENCE_MODE=dual
DUAL_API_URL=https://gateway-48587430648.europe-west6.run.app
DUAL_API_KEY=...
DUAL_ORG_ID=...
DUAL_AGENT_PASSPORT_TEMPLATE_ID=...
DUAL_AGENT_PASSPORT_OBJECT_ID=...
DUAL_AUTH_MODE=api_key
DUAL_WRITE_MODE=read_only
```

The adapter is intentionally optional. If the DUAL SDK or credentials are unavailable, the app keeps running in local simulator mode.

With API-key auth, the app can link to and verify a real DUAL passport object. Event-bus writes require bearer/session auth, so production should stay in `DUAL_WRITE_MODE=read_only` unless a suitable session token is explicitly provided.

Useful endpoints:

```text
GET  /api/dual/status
GET  /api/dual/write-readiness
GET  /api/dual/replay-queue
GET  /api/dual/passport
GET  /api/dual/template-readback
POST /api/dual/template
POST /api/dual/sync-passport
GET  /api/proof
GET  /api/proof/verify
```

Template schema: `dual-agent-passport.schema.json`.

`/api/proof` returns a portable proof bundle with Kraken source status, DUAL template/passport readback, write-readiness, local audit root hash, replay queue root, latest event hashes, caveats, verification checks, and a stable bundle hash. `generatedAt` is outside the hashed payload, so repeated proof reads produce the same hash until the underlying demo state changes. `/api/proof/verify` returns the verifier result and check list. `/api/dual/replay-queue` exposes the exact DUAL event-bus envelopes that become executable once bearer/session auth is provisioned.

## DUAL Object Model

The MVP uses a DUAL-shaped object named `agent_trading_passport`:

- `mode`: paper
- `allowedPairs`: BTCUSD, ETHUSD, SOLUSD
- `maxNotionalUsd`: 250
- `maxDailyNotionalUsd`: 1000
- `leverageAllowed`: false
- `humanApprovalRequiredAbove`: 100
- `dualObjectState`: active, awaiting approval, approved, executed, blocked

Every important action creates an audit event with a provenance hash.

## Safety Rules

- Public demo is paper-only.
- No Kraken API keys are required.
- No keys should be placed in browser code, DUAL objects, screenshots, logs, or commits.
- Live trading is intentionally out of scope for this repo until a separate private safety review.

## Build Roadmap

1. Replace read-linked DUAL mode with bearer-authenticated event-bus write sync.
2. Add tournament mode with multiple agent passports.
3. Add exportable audit bundle.
4. Add read-only Kraken account view for private demos.
5. Add live-trading controls only after explicit approval, least-privilege keys, validation mode, and emergency cancellation flow.
