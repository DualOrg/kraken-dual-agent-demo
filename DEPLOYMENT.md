# Deployment Notes

## Local Demo

Use local mode for the best demo today:

```bash
npm install
npm start
```

This supports real Kraken CLI calls if the binary is installed on the machine running the server.

## Vercel Caveat

The dashboard can be hosted anywhere. Kraken CLI execution requires the `kraken` binary to exist in the server runtime; a default Vercel serverless runtime will not have that binary unless a custom build step or packaged binary is added.

For Vercel, the app now falls back from Kraken CLI to Kraken's public ticker API for market data. Paper trade execution remains simulator-safe unless the CLI exists in the runtime.

For a Vercel-hosted demo, use one of these paths:

1. Use Kraken public API market data plus simulator-safe paper execution for public demos.
2. Host the server on a small VM where Kraken CLI is installed.
3. Replace CLI execution with Kraken MCP/tool calls if the runtime exposes them.

## Environment

No environment variables are required for the paper/simulator MVP.

Do not add live Kraken API keys to this demo until a separate safety review is completed.

## DUAL-Backed Deployment

To enable real DUAL persistence in Vercel, add these environment variables to the project:

```text
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
DUAL_L3_EXPLORER_BASE_URL=https://explorer-testnet.dual.network
DUAL_L2_EXPLORER_BASE_URL=https://explorer-test-v2.dual.network
DUAL_L1_EXPLORER_BASE_URL=
DEMO_ENABLE_EMAIL_AUTH=false
DEMO_PUBLIC_DUAL_WRITES=true
```

The runtime also needs `dual-sdk` available. If the package is not installed in the deployment, `/api/dual/status` will report the SDK as unavailable and the app should remain in local mode.

API-key auth is suitable for linking the Vercel deployment to a real DUAL passport object and writing event-bus actions when the key is scoped for event-bus action creation. Use the current testnet host and `/ebus/execute` path. `DUAL_AUTH_MODE=api_key` sends the scoped key as `x-api-key`; `/ebus/execute` no longer needs a DUAL bearer token. Older deployments that still set `DUAL_AUTH_MODE=both` are treated as `api_key`.

Email-code auth is not required for the public demo. Leave `DEMO_ENABLE_EMAIL_AUTH=false` unless you deliberately want a private browser fallback. The production route is scoped API-key auth plus public demo writes.

The app exposes DUAL data links in `/api/health`, `/api/dual/status`, `/api/proof`, and the Proof panel. By default, template and object cards open DUAL Console collection pages with the explicit entity id in the URL, action cards open the DUAL L3 explorer at `https://explorer-testnet.dual.network/actions/{actionId}`, and batch/roll-up cards open the DUAL L2 explorer at `https://explorer-test-v2.dual.network/tx/{transactionHash}` when a batch transaction hash is present. Each card keeps an app-served `Data` target under `/api/dual/records/...` for verified readback. Override `DUAL_L3_EXPLORER_BASE_URL`, `DUAL_L3_ACTION_URL_TEMPLATE`, `DUAL_L2_EXPLORER_BASE_URL`, `DUAL_L2_TX_URL_TEMPLATE`, `DUAL_L1_EXPLORER_BASE_URL`, or `DUAL_L1_ROLLUP_TX_URL_TEMPLATE` only if the explorer route changes. Legacy `DUAL_BLOCKSCOUT_*` variables are accepted as fallbacks, but new deployments should prefer the explicit L3/L2/L1 names. Override Console URL templates only after the target route has been verified.

Recommended rollout:

1. Create the DUAL passport template from `dual-agent-passport.schema.json`.
2. Mint one passport object for the Kraken Market Agent.
3. Set `DUAL_AGENT_PASSPORT_OBJECT_ID` in Vercel.
4. Create the DUAL trade receipt template from `dual-trade-receipt.schema.json`.
5. Set `DUAL_TRADE_RECEIPT_TEMPLATE_ID` in Vercel.
6. Set `DEMO_PUBLIC_DUAL_WRITES=true` or leave it unset; public demo writes default to enabled when DUAL write readiness is active.
7. Set `DUAL_WRITE_MODE=event_bus` for scoped API-key deployments.
8. Verify the default Console, L3 explorer, L2 explorer, and L1 roll-up links, then override the URL templates only if DUAL changes the route shape.
9. Redeploy and verify `/api/dual/status`, `/api/dual/write-readiness`, `/api/dual/trade-receipts`, `/api/proof`, `/api/proof/verify`, `/api/openapi.json`, and MCP `initialize` / `tools/list` on `/mcp`.

With `DEMO_PUBLIC_DUAL_WRITES=true`, production creates DUAL action logs for public paper-trade demo events whenever the server-side scoped API key is write-ready. Set `DEMO_PUBLIC_DUAL_WRITES=false` only for a read-linked rehearsal deployment. New receipt objects also require `DUAL_TRADE_RECEIPT_TEMPLATE_ID` or a receipt template created from the Proof panel for the current server run.

## API and MCP Checks

The public contract is:

- HTTP API description: `GET /api/openapi.json`
- MCP facade: `POST /mcp`

The MCP surface is safe to expose for public demos because its trading tools are paper-only and its standalone DUAL tools are read/replay-queue/receipt inspection only. When DUAL write readiness is active, MCP paper-trade evidence anchors automatically through the server-side scoped API key.

No MCP authentication is required for the demo. If DUAL write readiness is unavailable, MCP trades execute locally and return top-level anchoring warnings rather than silently implying Console-visible writes.

For browser-based MCP hosts that send an `Origin` header from a different host, set `DEMO_MCP_ALLOWED_ORIGINS` to the comma-separated allowed origins. Server-side MCP clients normally do not need this because they do not send browser CORS origins.
