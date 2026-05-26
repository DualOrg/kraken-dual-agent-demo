# Contributing

This repository is a public DUAL/Kraken demo. Contributions should preserve the core safety boundary: paper trading only, no live Kraken order placement, and no secrets in browser-visible code or committed files.

## Before You Start

- Open an issue for substantial behavior, security, DUAL-write, or deployment changes.
- Keep UI, API, and MCP behavior aligned. Agent tools should use the same policy path as the browser UI.
- Treat DUAL writes as paper-trade evidence only.
- Do not add live Kraken API keys, live order placement, wallet secrets, bearer tokens, refresh tokens, or private account data.

## Local Setup

```bash
git clone https://github.com/DualOrg/kraken-dual-agent-demo.git
cd kraken-dual-agent-demo
npm install
npm start
```

Open <http://localhost:4173>.

## Checks

Run the static check:

```bash
npm run check
```

Run the smoke test against a local server:

```bash
npm start
```

In another terminal:

```bash
npm test
```

The smoke test resets demo state, creates paper trades, checks proof surfaces, exercises MCP tools, and confirms a red-team action is blocked.

## Pull Request Checklist

- The demo remains paper-only.
- No secrets, tokens, credentials, private wallet data, or live trading controls are committed.
- New DUAL write behavior is gated by server-side readiness and documented in the README or deployment notes.
- UI, REST, and MCP surfaces agree on policy behavior.
- `npm run check` passes.
- `npm test` passes against a local or disposable demo server when runtime behavior changes.

## License

No open-source license is declared yet. Treat this repository as a DualOrg demo artifact until a `LICENSE` file is added.
