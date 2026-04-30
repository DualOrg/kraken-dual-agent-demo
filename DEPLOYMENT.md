# Deployment Notes

## Local Demo

Use local mode for the best demo today:

```bash
npm start
```

This supports real Kraken CLI calls if the binary is installed on the machine running the server.

## Vercel Caveat

The dashboard can be hosted anywhere, but Kraken CLI execution requires the `kraken` binary to exist in the server runtime. A default Vercel serverless runtime will not have that binary unless a custom build step or packaged binary is added.

For a Vercel-hosted demo, use one of these paths:

1. Keep simulator mode enabled for public demos.
2. Host the server on a small VM where Kraken CLI is installed.
3. Replace CLI execution with Kraken MCP/tool calls if the runtime exposes them.

## Environment

No environment variables are required for the paper/simulator MVP.

Do not add live Kraken API keys to this demo until a separate safety review is completed.

## DUAL-Backed Deployment

To enable real DUAL persistence in Vercel, add these environment variables to the project:

```text
DUAL_PERSISTENCE_MODE=dual
DUAL_API_URL=https://gateway-48587430648.europe-west6.run.app
DUAL_API_KEY=...
DUAL_ORG_ID=...
DUAL_AGENT_PASSPORT_TEMPLATE_ID=...
DUAL_AGENT_PASSPORT_OBJECT_ID=...
```

The runtime also needs `dual-sdk` available. If the package is not installed in the deployment, `/api/dual/status` will report the SDK as unavailable and the app should remain in local mode.

Recommended rollout:

1. Create the DUAL template from `dual-agent-passport.schema.json`.
2. Mint one passport object for the Kraken Market Agent.
3. Set `DUAL_AGENT_PASSPORT_OBJECT_ID` in Vercel.
4. Redeploy and verify `/api/dual/status`.
