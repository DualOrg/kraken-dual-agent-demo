# Deployment Notes

## Local Demo

Use local mode for the best demo today:

```bash
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
DUAL_CONSOLE_BASE_URL=https://console-testnet.dual.network
DUAL_BLOCKSCOUT_BASE_URL=...
DEMO_ENABLE_EMAIL_AUTH=false
DEMO_OPERATOR_TOKEN=...
```

The runtime also needs `dual-sdk` available. If the package is not installed in the deployment, `/api/dual/status` will report the SDK as unavailable and the app should remain in local mode.

API-key auth is suitable for linking the Vercel deployment to a real DUAL passport object and writing event-bus actions when the key is scoped for event-bus action creation. Use the current testnet host and `/ebus/execute` path. `DUAL_AUTH_MODE=api_key` sends the scoped key as `x-api-key`; `/ebus/execute` no longer needs a DUAL bearer token. Older deployments that still set `DUAL_AUTH_MODE=both` are treated as `api_key`.

Email-code auth is not required for the public demo. Leave `DEMO_ENABLE_EMAIL_AUTH=false` unless you deliberately want a private browser operator fallback; the production route should be scoped API-key auth plus `DEMO_OPERATOR_TOKEN`.

The app exposes DUAL data links in `/api/health`, `/api/dual/status`, `/api/proof`, and the Proof panel. Console links default to explicit entity routes: `https://console-testnet.dual.network/{orgId}/collections/templates/{templateId}`, `/objects/{objectId}`, and `/action-logs/{actionId}`. Set `DUAL_CONSOLE_TEMPLATE_URL_TEMPLATE`, `DUAL_CONSOLE_OBJECT_URL_TEMPLATE`, or `DUAL_CONSOLE_ACTION_URL_TEMPLATE` if the Console detail routes differ. Set `DUAL_BLOCKSCOUT_BASE_URL` or `DUAL_BLOCKSCOUT_TX_URL_TEMPLATE` when finalized batch transaction hashes should open directly in Blockscout.

Recommended rollout:

1. Create the DUAL passport template from `dual-agent-passport.schema.json`.
2. Mint one passport object for the Kraken Market Agent.
3. Set `DUAL_AGENT_PASSPORT_OBJECT_ID` in Vercel.
4. Create the DUAL trade receipt template from `dual-trade-receipt.schema.json`.
5. Set `DUAL_TRADE_RECEIPT_TEMPLATE_ID` in Vercel.
6. Set `DEMO_OPERATOR_TOKEN` so public DUAL write endpoints fail closed unless the operator sends the token.
7. Set `DUAL_WRITE_MODE=event_bus` for scoped API-key deployments.
8. Set `DUAL_CONSOLE_BASE_URL=https://console-testnet.dual.network` and any available Blockscout base/template URL.
9. Redeploy and verify `/api/dual/status`, `/api/dual/trade-receipts`, `/api/proof`, `/api/proof/verify`, `/api/openapi.json`, and MCP `initialize` / `tools/list` on `/mcp`.

Without `DEMO_OPERATOR_TOKEN`, production remains read-linked for public requests even if DUAL write credentials are present. This is intentional: anonymous visitors can inspect proof and exercise local demo state, but they cannot replay passport events or mint trade receipts into DUAL.

## API and MCP Checks

The public contract is:

- HTTP API description: `GET /api/openapi.json`
- MCP facade: `POST /mcp`

The MCP surface is safe to expose for public demos because its trading tools are paper-only and its DUAL tools are read/replay-queue/receipt inspection only. DUAL replay execution and trade receipt minting still require the existing operator-gated HTTP endpoints and `DEMO_OPERATOR_TOKEN`.

For browser-based MCP hosts that send an `Origin` header from a different host, set `DEMO_MCP_ALLOWED_ORIGINS` to the comma-separated allowed origins. Server-side MCP clients normally do not need this because they do not send browser CORS origins.
