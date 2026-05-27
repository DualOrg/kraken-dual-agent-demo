# DUAL x Kraken Agent Trading Passport

A safe paper-trading demo that shows Kraken as the market/execution venue and DUAL as the policy, approval, state, audit, and proof layer for an AI agent.

The short version:

> Kraken executes. DUAL governs, approves, records, and proves.

This repo is intentionally paper-only. It does not require Kraken API keys, does not place live Kraken orders, and should not be used for live trading without a separate private safety review.

## Live Demo

Open the public demo:

<https://kraken-dual-agent-demo.vercel.app/>

What to look for:

- `MODE PAPER`: no real Kraken order is placed.
- `KRAKEN PUBLIC API LIVE`: market data is coming from Kraken public data when available.
- `AGENT MANDATE`: the paper execution request is checked against the DUAL-backed Agent Mandates demo before a fill.
- `DUAL WRITE-SYNC LIVE` or local DUAL status: shows whether paper-trade evidence is being written to DUAL or simulated locally.
- `TRANSACTION HISTORY`: executed paper trades and blocked-policy proofs.
- `LIVE PROOF`: proof hash, verifier status, DUAL readback, and settlement route.
- `DUAL BINDING`: template, passport object, action log, receipt, batch, and explorer/data links.

For presenter guidance, use:

- [Demo playbook](docs/kraken-dual-demo-playbook.md)
- [L3/L2/L1 run sheet](docs/kraken-dual-l3-l2-l1-demo-run-sheet.md)
- [Deployment notes](DEPLOYMENT.md)

## New User Paths

Use the path that matches what you are trying to do.

| Path | Use this when | Requires credentials |
| --- | --- | --- |
| Live demo viewer | You only want to inspect the current public demo. | No |
| Local developer | You want to run and change the paper demo locally. | No |
| DUAL operator | You want DUAL object/action/receipt writes. | Yes, scoped DUAL API key |
| Private trading research | You want live Kraken trading or account access. | Not supported in this repo |

## Requirements

- Node.js 20 or newer.
- npm.
- Git.
- Network access to GitHub during `npm install` because `dual-sdk` is installed from `DualOrg/dual-sdk-ts`.
- Optional: Kraken CLI, only if you want local Kraken CLI paper commands. The app works without it.

## Quick Start: Local Paper Demo

```bash
git clone https://github.com/DualOrg/kraken-dual-agent-demo.git
cd kraken-dual-agent-demo
npm install
npm start
```

Open <http://localhost:4173>.

No `.env` file is required for the local paper/simulator path. The app will:

- Try Kraken CLI market data if the `kraken` binary is installed.
- Fall back to Kraken public market-data API when Kraken CLI is unavailable.
- Fall back to deterministic simulator data only when both are unavailable.
- Keep DUAL state local unless DUAL credentials are configured.

If port `4173` is busy:

```bash
PORT=4174 npm start
```

## Optional Local `.env`

For explicit local settings, copy the example:

```bash
cp .env.example .env
```

The default `.env.example` is safe for local paper mode and keeps DUAL writes disabled. Do not put secrets in browser code, screenshots, logs, commits, or DUAL objects.

## First Run Walkthrough

After the app opens:

1. Confirm the status chips show `PAPER` and either Kraken public data or simulator fallback.
2. Use the default safe proposal, or choose `DUALUSD`, `buy`, and a small notional such as `$10` or `$75`.
3. Click `CHECK POLICY`.
4. Confirm the local policy decision is `ALLOW` and the Agent Mandates gate is `APPROVED`.
5. Click `EXECUTE PAPER TRADE`.
6. Open or inspect `TRANSACTION HISTORY` and `LIVE PROOF`.
7. Trigger a red-team scenario, such as leverage or oversized order, and confirm it is blocked.

The successful paper trade proves the happy path. The blocked action proves the agent is constrained by a mandate.

## Test and Validate

Static syntax check:

```bash
npm run check
```

Smoke test against a running server:

```bash
npm start
```

In another terminal:

```bash
npm test
```

The smoke test resets local state, executes paper trades, checks proof/readback surfaces, verifies MCP tools, and checks red-team blocking. Use it against local or disposable demo state.

To test a different URL:

```bash
DEMO_BASE_URL=http://localhost:4174 npm test
```

## Modes

### Local Mode

Local mode is the default. It needs no credentials and is the best path for a new developer.

```text
DUAL_PERSISTENCE_MODE=local
```

### DUAL-Backed Mode

DUAL-backed mode links the demo to real DUAL templates, a passport object, event-bus actions, receipt objects, and batch/readback evidence.

Minimum server-side configuration:

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
DEMO_ENABLE_EMAIL_AUTH=false
DEMO_PUBLIC_DUAL_WRITES=true
```

The DUAL adapter is optional. If the SDK or credentials are unavailable, the app keeps running in local simulator mode.

### Agent Mandates Gate

The Kraken demo also calls Agent Mandates before paper execution. By default it uses the direct HTTP evaluator. If `AGENT_MANDATES_MCP_URL` is set, it calls the read-only MCP tool `agent_mandates_evaluate_action` instead. Neither path requires or exposes the Agent Mandates operator token.

```bash
AGENT_MANDATES_URL=https://agent-mandates-dual-demo.vercel.app
# Optional MCP transport:
# AGENT_MANDATES_MCP_URL=https://agent-mandates-dual-demo.vercel.app/mcp
AGENT_MANDATES_GATE_MODE=required
AGENT_MANDATES_OBJECT_ID=6a165a5a0b0bf21f33c111cc
AGENT_MANDATES_AGENT_WALLET=agent-mandates-demo-agent-wallet-001
AGENT_MANDATES_JURISDICTION=AU-NSW
AGENT_MANDATES_AUTHORITY_SCOPE=buyer-agent-commerce
```

Use `AGENT_MANDATES_GATE_MODE=off` only for isolated local development. Production should keep the gate `required`.

### AutoChain MCP Gate

The Kraken demo also observes AutoChain over MCP before paper execution. By default it calls the public read-only AutoChain MCP, reads the canonical warranty claim, evaluates its next gate, and attaches that decision to the trade proposal. It never calls AutoChain write tools and never uses an AutoChain operator token.

```bash
AUTOCHAIN_MCP_URL=https://autochain-eight.vercel.app/mcp
AUTOCHAIN_GATE_MODE=observe
```

Use `AUTOCHAIN_GATE_MODE=required` only when a Kraken paper action should be blocked if AutoChain cannot approve the current claim gate. Use `AUTOCHAIN_GATE_MODE=off` to disable the integration.

### Public Deployment Mode

Public deployments can write paper-trade evidence to DUAL when all of these are true:

- `DUAL_PERSISTENCE_MODE=dual`
- A scoped server-side `DUAL_API_KEY` is configured.
- `DUAL_WRITE_MODE=event_bus`
- `DEMO_PUBLIC_DUAL_WRITES=true`
- The passport template/object and trade receipt template are configured.

There is no browser token step for the public demo. The older DUAL email-code flow is hidden unless `DEMO_ENABLE_EMAIL_AUTH=true` is explicitly set for a private fallback.

## DUAL Setup Checklist

1. Create the DUAL passport template from [dual-agent-passport.schema.json](dual-agent-passport.schema.json).
2. Mint one passport object for the Kraken Market Agent.
3. Set `DUAL_AGENT_PASSPORT_TEMPLATE_ID`.
4. Set `DUAL_AGENT_PASSPORT_OBJECT_ID`.
5. Create the trade receipt template from [dual-trade-receipt.schema.json](dual-trade-receipt.schema.json).
6. Set `DUAL_TRADE_RECEIPT_TEMPLATE_ID`.
7. Set `DUAL_AUTH_MODE=api_key`.
8. Set `DUAL_WRITE_MODE=event_bus`.
9. Set `DUAL_EVENTBUS_WRITE_PATH=/ebus/execute`.
10. Set `DEMO_PUBLIC_DUAL_WRITES=true` only for a deployment intended to create DUAL paper-trade evidence.
11. Verify:
    - `GET /api/dual/status`
    - `GET /api/dual/write-readiness`
    - `GET /api/proof`
    - `GET /api/proof/verify`
    - `GET /api/transactions/history`

## Kraken CLI Integration

Kraken CLI is optional. Install it only when you want local CLI-backed market or paper command paths:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh
```

The adapter targets these safe commands:

```bash
kraken ticker BTCUSD -o json
kraken ticker DUALUSD -o json
kraken paper init --balance 10000 -o json
kraken paper buy BTCUSD 0.01 -o json
kraken paper buy DUALUSD 1000 -o json
```

If the binary is missing or returns an error, the app falls back to Kraken public ticker API for market data. It uses deterministic simulated data only if both CLI and public API are unavailable.

On Vercel, the default serverless runtime will not have the `kraken` binary. Use Kraken public API plus simulator-safe paper execution there unless you package a binary, host the server on a VM, or replace CLI execution with an approved tool path.

## API Quick Checks

```bash
curl http://localhost:4173/api/health
curl http://localhost:4173/api/proof
curl http://localhost:4173/api/proof/verify
curl http://localhost:4173/api/transactions/history
```

Useful endpoints:

```text
GET  /api/openapi.json
GET  /api/health
GET  /api/market?pair=DUALUSD
POST /api/propose
POST /api/execute-paper
POST /api/red-team
GET  /api/dual/status
GET  /api/dual/write-readiness
GET  /api/dual/auth/status
POST /api/dual/auth/request-code
POST /api/dual/auth/verify-code
GET  /api/dual/replay-queue
POST /api/dual/replay-queue/execute
GET  /api/dual/trade-receipts
POST /api/dual/trade-receipts/replay
GET  /api/dual/records/templates/{templateId}
GET  /api/dual/records/objects/{objectId}
GET  /api/dual/records/actions/{actionId}
GET  /api/dual/records/batches/{batchId}
GET  /api/dual/passport
GET  /api/dual/template-readback
GET  /api/transactions/history
GET  /api/dual/transaction-history
POST /api/dual/template
POST /api/dual/action-passport/setup
POST /api/dual/trade-receipt-template/setup
POST /api/dual/sync-passport
GET  /api/proof
GET  /api/proof/verify
POST /mcp
```

`/api/proof` returns a portable proof bundle with Kraken source status, DUAL template/passport readback, trade receipt template/readiness, write-readiness, DUAL record/explorer link metadata, local audit root hash, replay queue root, trade receipt root, latest event hashes, caveats, verification checks, latest DUAL sequencer batch status, and a stable bundle hash.

`/api/transactions/history` returns executed paper trades and blocked-policy proofs as a presenter-ready proof ledger with proposal id, receipt id, pair, side, quantity, price, notional, DUAL receipt object, L3 action, L2 batch, L1 roll-up, route steps, and app-served record links.

The proof bundle surfaces latest batch id, status, proof value, Merkle root, L3 action hash, L2 batch transaction hash, and L1 roll-up transaction hash when available. The UI shows this as `L3 action -> L2 batch -> L1 roll-up`.

## MCP Quick Start

`POST /mcp` is a JSON-RPC MCP facade for agent clients. It is paper-only and does not expose live Kraken order placement.

Initialize:

```bash
curl -s http://localhost:4173/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

List tools:

```bash
curl -s http://localhost:4173/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Execute a small paper trade through the same policy path as the UI:

```bash
curl -s http://localhost:4173/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kraken_dual_propose_and_execute_paper_trade","arguments":{"pair":"DUALUSD","side":"buy","notional_usd":10}}}'
```

Available MCP tools:

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
- `kraken_dual_get_transaction_history`
- `kraken_dual_red_team`

The tools support `DUALUSD`, `BTCUSD`, `ETHUSD`, and `SOLUSD`. If DUAL write readiness is unavailable, paper trades still execute locally and return top-level warnings such as `dual_anchoring_not_available`, `dual_replay_pending`, or `dual_receipts_pending`.

For browser-based MCP hosts that send an `Origin` header from a different host, set `DEMO_MCP_ALLOWED_ORIGINS` to the comma-separated allowed origins.

## DUAL Object Model

The demo uses a DUAL-shaped object named `agent_trading_passport`:

- `mode`: paper
- `allowedPairs`: `BTCUSD`, `ETHUSD`, `SOLUSD`, `DUALUSD`
- `maxNotionalUsd`: `250`
- `maxDailyNotionalUsd`: `1000`
- `leverageAllowed`: `false`
- `humanApprovalRequiredAbove`: `100`
- `dualObjectState`: `active`, `awaiting approval`, `approved`, `executed`, `blocked`

Every important action creates an audit event with a provenance hash. Every successful paper execution also creates a `trade_receipt`:

- `receipt_id`: deterministic local receipt id
- `passport_id`: linked agent passport
- `proposal_id`: linked trade proposal
- `trade_pair`, `trade_side`, `trade_quantity`, `trade_price_usd`, `notional_usd`
- `policy_version`, `policy_hash`, `policy_decision`
- `execution_mode`, `execution_source`, `execution_digest`
- `event_id`, `event_hash`, `receipt_hash`

When the DUAL receipt template is configured, these receipts can be minted one-per-trade as DUAL objects.

## DUAL Links and Explorer Routes

The app keeps both human-facing links and app-served data links:

- Console org: `https://console-testnet.dual.network/{orgId}`
- Console template: `https://console-testnet.dual.network/{orgId}/collections/templates?templateId={templateId}`
- Console object: `https://console-testnet.dual.network/{orgId}/collections/objects?objectId={objectId}`
- Console action log: `https://console-testnet.dual.network/{orgId}/collections/action-logs?actionId={actionId}`
- L3 action explorer: `https://explorer-testnet.dual.network/actions/{actionId}`
- L2 batch transaction: `https://explorer-test-v2.dual.network/tx/{transactionHash}`
- App data readback: `/api/dual/records/...`

Override `DUAL_CONSOLE_*`, `DUAL_L3_*`, `DUAL_L2_*`, or `DUAL_L1_*` URL templates only after the target route has been verified. Legacy `DUAL_BLOCKSCOUT_*` variables are still accepted as fallbacks.

## Safety Rules

- Public demo is paper-only.
- No Kraken API keys are required.
- No live Kraken order placement is exposed by the UI or public MCP surface.
- No keys should be placed in browser code, DUAL objects, screenshots, logs, or commits.
- DUAL writes are only for paper-trade evidence and only when server-side DUAL write readiness is active.
- Live trading is out of scope until explicit approval, least-privilege keys, validation mode, and emergency cancellation controls exist.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `npm install` cannot fetch `dual-sdk` | GitHub access/network issue for `DualOrg/dual-sdk-ts`. | Confirm GitHub access and retry with network access. |
| Port `4173` is busy | Another local server is running. | Start with `PORT=4174 npm start`. |
| UI shows local DUAL mode | `DUAL_PERSISTENCE_MODE=local` or missing DUAL credentials. | Configure DUAL env vars only if you need live DUAL writes. |
| DUAL writes are pending | Missing scoped API key, template, passport object, receipt template, or `DUAL_WRITE_MODE=event_bus`. | Check `/api/dual/write-readiness`. |
| Kraken CLI unavailable | `kraken` binary is not installed or not in `PATH`. | Let the app use Kraken public API fallback, or install Kraken CLI. |
| Vercel paper execution is simulated | Serverless runtime has no `kraken` binary. | Use public API/simulator path, package the binary, or host on a VM. |
| MCP browser client fails CORS | Origin is not allowlisted. | Set `DEMO_MCP_ALLOWED_ORIGINS`. |

## Support and Contributing

This is a public demo repo under `DualOrg`.

- Issues: <https://github.com/DualOrg/kraken-dual-agent-demo/issues>
- Repository: <https://github.com/DualOrg/kraken-dual-agent-demo>
- Contribution guidance: [CONTRIBUTING.md](CONTRIBUTING.md)
- License status: no open-source license is declared yet. Treat the code as a DualOrg demo artifact until a `LICENSE` file is added.

## Build Roadmap

1. Add tournament mode with multiple agent passports.
2. Add exportable audit bundle.
3. Add read-only Kraken account view for private demos.
4. Replace demo-local state with durable storage if this becomes more than a public demo.
5. Add live-trading controls only after explicit approval, least-privilege keys, validation mode, and emergency cancellation flow.
