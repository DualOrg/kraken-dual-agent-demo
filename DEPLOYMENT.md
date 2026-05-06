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
DUAL_AUTH_MODE=api_key
DUAL_WRITE_MODE=event_bus
DUAL_EVENTBUS_WRITE_PATH=/ebus/actions
```

The runtime also needs `dual-sdk` available. If the package is not installed in the deployment, `/api/dual/status` will report the SDK as unavailable and the app should remain in local mode.

API-key auth is suitable for linking the Vercel deployment to a real DUAL passport object and writing event-bus actions when the key is scoped for event-bus action creation. Use the current testnet host and `/ebus/actions` path.

Recommended rollout:

1. Create the DUAL template from `dual-agent-passport.schema.json`.
2. Mint one passport object for the Kraken Market Agent.
3. Set `DUAL_AGENT_PASSPORT_OBJECT_ID` in Vercel.
4. Set `DUAL_WRITE_MODE=event_bus` for scoped API-key deployments.
5. Redeploy and verify `/api/dual/status`.
