# DUAL x Kraken Agent Trading Passport

A safe partner-demo repo that shows Kraken as the agent execution venue and DUAL as the policy, approval, and audit layer.

The public MVP runs in paper/simulator mode by default:

- Kraken CLI market data if `kraken` is installed.
- Kraken public market-data API when Kraken CLI is unavailable.
- Simulator fallback only when both Kraken CLI and Kraken public API are unavailable.
- Kraken spot paper trade command path when available, including DUALUSD paper trades.
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
kraken ticker DUALUSD -o json
kraken paper init --balance 10000 -o json
kraken paper buy BTCUSD 0.01 -o json
kraken paper buy DUALUSD 1000 -o json
```

If the binary is missing or returns an error, the app falls back to Kraken's public ticker API for market data. It uses deterministic simulated data only if both CLI and public API are unavailable.

## DUAL Persistence

By default the demo uses local persistence. To sync lifecycle events to real DUAL objects, configure:

```bash
DUAL_PERSISTENCE_MODE=dual
DUAL_API_URL=https://api-testnet.dual.network
DUAL_API_KEY=...
DUAL_ORG_ID=...
DUAL_AGENT_PASSPORT_TEMPLATE_ID=...
DUAL_AGENT_PASSPORT_OBJECT_ID=...
DUAL_AUTH_MODE=both
DUAL_WRITE_MODE=event_bus
DUAL_EVENTBUS_WRITE_PATH=/ebus/execute
DUAL_SERVICE_ACCOUNT_AUTH_MODE=both
DUAL_SERVICE_ACCOUNT_TOKEN=...
DUAL_SERVICE_ACCOUNT_REFRESH_TOKEN=...
DEMO_OPERATOR_TOKEN=...
```

The adapter is intentionally optional. If the DUAL SDK or credentials are unavailable, the app keeps running in local simulator mode.

With current DUAL testnet auth, API-key auth can link to and verify a real DUAL passport object and can also write event-bus actions when the key is scoped for event-bus action creation. Set `DUAL_WRITE_MODE=event_bus` and use the current action path `/ebus/execute`. `DUAL_AUTH_MODE=both` sends the scoped key as both `x-api-key` and `Authorization: Bearer ...` for compatibility while DUAL rolls out event-bus API-key auth. Bearer email sessions, refresh-token service sessions, and direct bearer service tokens remain supported as fallback write-auth modes.

The app also supports an operator email-code flow for bearer auth. A code is requested from DUAL, verified server-side, switched into the configured org, and held only in the server session. Once authenticated, new audit events write through the DUAL event bus and the replay queue can be executed into DUAL.

Public deployments are read-linked by default. Server-side DUAL writes are blocked unless the request is operator-authorized with `x-demo-operator-token` or `Authorization: Bearer <DEMO_OPERATOR_TOKEN>`. This keeps the public demo safe while still allowing the operator to replay events into DUAL.

Useful endpoints:

```text
GET  /api/dual/status
GET  /api/dual/write-readiness
GET  /api/dual/auth/status
POST /api/dual/auth/request-code
POST /api/dual/auth/verify-code
GET  /api/dual/replay-queue
POST /api/dual/replay-queue/execute
GET  /api/dual/passport
GET  /api/dual/template-readback
POST /api/dual/template
POST /api/dual/sync-passport
GET  /api/proof
GET  /api/proof/verify
```

Template schema: `dual-agent-passport.schema.json`.

`/api/proof` returns a portable proof bundle with Kraken source status, DUAL template/passport readback, write-readiness, local audit root hash, replay queue root, latest event hashes, caveats, verification checks, latest DUAL sequencer batch status, and a stable bundle hash. `generatedAt` is outside the hashed payload, so repeated proof reads produce the same hash until the underlying demo state changes. `/api/proof/verify` returns the verifier result and check list. `/api/dual/replay-queue` exposes the exact DUAL event-bus envelopes. `/api/dual/replay-queue/execute` executes those envelopes oldest-first once the server has API-key or bearer/session write auth for `/ebus/execute`.

The proof bundle surfaces latest batch id, status, proof value, Merkle root, and L1 transaction hash when available. The UI shows this as first-class `DUAL batch` and `Batch proof` rows.

## DUAL Object Model

The MVP uses a DUAL-shaped object named `agent_trading_passport`:

- `mode`: paper
- `allowedPairs`: BTCUSD, ETHUSD, SOLUSD, DUALUSD
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
- Public DUAL writes require an operator token; anonymous visitors can read proof and run local demo actions only.
- Live trading is intentionally out of scope for this repo until a separate private safety review.

## Build Roadmap

1. Add tournament mode with multiple agent passports.
2. Add exportable audit bundle.
3. Add read-only Kraken account view for private demos.
4. Replace demo-local state with durable storage if this becomes more than a public demo.
5. Add live-trading controls only after explicit approval, least-privilege keys, validation mode, and emergency cancellation flow.
