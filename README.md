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
DUAL_TRADE_RECEIPT_TEMPLATE_ID=...
DUAL_AUTH_MODE=api_key
DUAL_WRITE_MODE=event_bus
DUAL_EVENTBUS_WRITE_PATH=/ebus/execute
DUAL_SERVICE_ACCOUNT_TOKEN=...
DUAL_SERVICE_ACCOUNT_REFRESH_TOKEN=...
DUAL_CONSOLE_BASE_URL=https://console-testnet.dual.network
DUAL_BLOCKSCOUT_BASE_URL=...
DEMO_ENABLE_EMAIL_AUTH=false
DEMO_OPERATOR_TOKEN=...
```

The adapter is intentionally optional. If the DUAL SDK or credentials are unavailable, the app keeps running in local simulator mode.

With current DUAL testnet auth, a scoped API key can link to and verify a real DUAL passport object and write event-bus actions. Set `DUAL_AUTH_MODE=api_key`, `DUAL_WRITE_MODE=event_bus`, and use the current action path `/ebus/execute`. The event-bus endpoint no longer needs a DUAL bearer token. The old `DUAL_AUTH_MODE=both` value is accepted as a legacy alias for `api_key` and does not cause the app to send a DUAL bearer header.

The app uses scoped API-key auth plus the demo operator gate as the default write path. The older DUAL email-code flow is not required for this demo and is hidden/disabled unless `DEMO_ENABLE_EMAIL_AUTH=true` is set for a private operator session fallback.

The proof and health payloads include explicit DUAL Console links by default using `DUAL_CONSOLE_BASE_URL` (`https://console-testnet.dual.network` unless overridden). The default URL templates point to the current passport template, passport object, latest receipt template/object when present, and latest DUAL action id when present. Set `DUAL_CONSOLE_TEMPLATE_URL_TEMPLATE`, `DUAL_CONSOLE_OBJECT_URL_TEMPLATE`, or `DUAL_CONSOLE_ACTION_URL_TEMPLATE` if the Console detail routes change. Set `DUAL_BLOCKSCOUT_BASE_URL` or `DUAL_BLOCKSCOUT_TX_URL_TEMPLATE` when the deployment has a public explorer route for finalized L1 transaction hashes.

Public deployments are read-linked by default. Server-side DUAL writes are blocked unless the request passes the demo operator gate with `x-demo-operator-token` or `Authorization: Bearer <DEMO_OPERATOR_TOKEN>`. This operator gate is separate from DUAL event-bus auth and keeps the public demo safe while still allowing the operator to replay events into DUAL.

Executed paper trades also create deterministic `trade_receipt` records. When `DUAL_TRADE_RECEIPT_TEMPLATE_ID` is configured and the request is operator-authorized, each executed trade can be minted as its own DUAL receipt object linked to the passport, proposal, policy hash, execution digest, and audit event. Without that template the app still creates local receipts and exposes a replay queue for later minting.

Useful endpoints:

```text
GET  /api/openapi.json
GET  /api/dual/status
GET  /api/dual/write-readiness
GET  /api/dual/auth/status
POST /api/dual/auth/request-code
POST /api/dual/auth/verify-code
GET  /api/dual/replay-queue
POST /api/dual/replay-queue/execute
GET  /api/dual/trade-receipts
POST /api/dual/trade-receipts/replay
GET  /api/dual/passport
GET  /api/dual/template-readback
POST /api/dual/template
POST /api/dual/action-passport/setup
POST /api/dual/trade-receipt-template/setup
POST /api/dual/sync-passport
GET  /api/proof
GET  /api/proof/verify
POST /mcp
```

Template schemas: `dual-agent-passport.schema.json` and `dual-trade-receipt.schema.json`.

`/api/proof` returns a portable proof bundle with Kraken source status, DUAL template/passport readback, trade receipt template/readiness, write-readiness, DUAL Console/Blockscout link metadata, local audit root hash, replay queue root, trade receipt root, latest event hashes, caveats, verification checks, latest DUAL sequencer batch status, and a stable bundle hash. `generatedAt` and presentation links are outside the hashed payload, so repeated proof reads produce the same hash until the underlying demo state changes. `/api/proof/verify` returns the verifier result and check list. `/api/dual/replay-queue` exposes the exact DUAL event-bus envelopes. `/api/dual/replay-queue/execute` executes those envelopes oldest-first once the server has scoped API-key write auth for `/ebus/execute`. `/api/dual/trade-receipts/replay` mints pending executed-trade receipts into DUAL once the trade receipt template and operator write auth are active.

The proof bundle surfaces latest batch id, status, proof value, Merkle root, and L1 transaction hash when available. The UI shows this as first-class `DUAL batch` and `Batch proof` rows.

## Agent API and MCP

`GET /api/openapi.json` exposes the HTTP surface for clients that want a normal REST contract. The document also advertises the MCP endpoint, tool names, and the public safety policy.

`POST /mcp` is a JSON-RPC MCP facade for agent clients. It exposes paper-only tools:

- `kraken_dual_get_status`
- `kraken_dual_get_market`
- `kraken_dual_propose_trade`
- `kraken_dual_approve_trade`
- `kraken_dual_execute_paper_trade`
- `kraken_dual_propose_and_execute_paper_trade`
- `kraken_dual_get_proof`
- `kraken_dual_verify_proof`
- `kraken_dual_get_audit`
- `kraken_dual_get_replay_queue`
- `kraken_dual_get_trade_receipts`
- `kraken_dual_red_team`

The MCP tools support `DUALUSD` alongside `BTCUSD`, `ETHUSD`, and `SOLUSD`. Trading tools only create or execute paper proposals through the same DUAL policy checks as the UI. Public MCP intentionally does not expose live Kraken order placement or DUAL replay execution.

## DUAL Object Model

The MVP uses a DUAL-shaped object named `agent_trading_passport`:

- `mode`: paper
- `allowedPairs`: BTCUSD, ETHUSD, SOLUSD, DUALUSD
- `maxNotionalUsd`: 250
- `maxDailyNotionalUsd`: 1000
- `leverageAllowed`: false
- `humanApprovalRequiredAbove`: 100
- `dualObjectState`: active, awaiting approval, approved, executed, blocked

Every important action creates an audit event with a provenance hash. Every successful paper execution also creates a `trade_receipt`:

- `receipt_id`: deterministic local receipt id
- `passport_id`: linked agent passport
- `proposal_id`: linked trade proposal
- `trade_pair`, `trade_side`, `trade_quantity`, `trade_price_usd`, `notional_usd`
- `policy_version`, `policy_hash`, `policy_decision`
- `execution_mode`, `execution_source`, `execution_digest`
- `event_id`, `event_hash`, `receipt_hash`

When the DUAL receipt template is configured, these receipts can be minted one-per-trade as DUAL objects.

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
