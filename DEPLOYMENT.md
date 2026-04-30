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
