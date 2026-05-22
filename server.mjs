import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadState, resetState, saveState, createAuditEvent, createProposal } from "./src/dualStore.mjs";
import { evaluateTrade, redTeamTrade, roundMoney, roundQty } from "./src/policy.mjs";
import { executePaperTrade, getAdapterStatus, getMarket } from "./src/krakenAdapter.mjs";
import { createDualPersistence } from "./src/dualPersistenceV3.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const publicDir = join(root, "public");
await loadDotEnv();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const dualPersistence = await createDualPersistence();
const dualSessionCookieName = "__Host-dual_kraken_session";
const operatorToken = process.env.DEMO_OPERATOR_TOKEN || process.env.DUAL_DEMO_OPERATOR_TOKEN || "";
const publicDualWrites = parseBoolean(process.env.DEMO_PUBLIC_DUAL_WRITES || "false");
const supportedPairs = ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"];
const appVersion = "0.1.0";
const mcpProtocolVersion = "2025-06-18";
const mcpServerInfo = {
  name: "kraken-dual-agent-demo",
  version: appVersion
};
const tradePairSchema = { type: "string", enum: supportedPairs, default: "DUALUSD" };
const tradeSideSchema = { type: "string", enum: ["buy", "sell"], default: "buy" };
const tradeNotionalSchema = { type: "number", minimum: 1, default: 75 };
const proposalIdSchema = { type: "string", pattern: "^prop-" };
const mcpTools = [
  mcpTool("kraken_dual_get_status", "Read demo health, paper trading mode, DUAL readiness, proof status, and latest audit summary.", {
    type: "object",
    additionalProperties: false,
    properties: {
      include_proof: { type: "boolean", default: true }
    }
  }),
  mcpTool("kraken_dual_get_market", "Read a Kraken market snapshot for an allowed paper-trading pair without placing an order.", {
    type: "object",
    additionalProperties: false,
    required: ["pair"],
    properties: {
      pair: tradePairSchema
    }
  }),
  mcpTool("kraken_dual_propose_trade", "Create a DUAL policy-checked paper trade proposal. This does not execute a trade.", {
    type: "object",
    additionalProperties: false,
    required: ["pair", "side", "notional_usd"],
    properties: {
      pair: tradePairSchema,
      side: tradeSideSchema,
      notional_usd: tradeNotionalSchema,
      approved: { type: "boolean", default: false }
    }
  }),
  mcpTool("kraken_dual_approve_trade", "Record human approval for a waiting paper trade proposal.", {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: proposalIdSchema
    }
  }),
  mcpTool("kraken_dual_execute_paper_trade", "Execute an existing approved proposal through the safe Kraken paper/simulator path.", {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: proposalIdSchema
    }
  }),
  mcpTool("kraken_dual_propose_and_execute_paper_trade", "Create and execute a DUAL-approved paper trade in one call when policy allows it.", {
    type: "object",
    additionalProperties: false,
    required: ["pair", "side", "notional_usd"],
    properties: {
      pair: tradePairSchema,
      side: tradeSideSchema,
      notional_usd: tradeNotionalSchema
    }
  }),
  mcpTool("kraken_dual_get_proof", "Read the portable DUAL x Kraken proof bundle.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }),
  mcpTool("kraken_dual_verify_proof", "Verify the current proof bundle and return validity, completeness, hashes, and checks.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }),
  mcpTool("kraken_dual_get_audit", "Read the latest local audit events and provenance hashes.", {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    }
  }),
  mcpTool("kraken_dual_get_replay_queue", "Read the DUAL event-bus replay queue. Public MCP does not execute replay writes.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }),
  mcpTool("kraken_dual_red_team", "Run a safe policy-violation scenario to prove unsafe trades are blocked before execution.", {
    type: "object",
    additionalProperties: false,
    required: ["scenario"],
    properties: {
      scenario: { type: "string", enum: ["oversized", "blocked_pair", "leverage", "missing_approval"], default: "leverage" }
    }
  })
];
const mcpResources = [
  mcpResource("kraken-dual://status", "Kraken DUAL status", "Health, policy, proof, and paper-execution status."),
  mcpResource("kraken-dual://proof", "Kraken DUAL proof", "Portable proof bundle for verifier readback."),
  mcpResource("kraken-dual://audit", "Kraken DUAL audit", "Latest audit events and provenance hashes."),
  mcpResource("kraken-dual://replay-queue", "Kraken DUAL replay queue", "Pending DUAL event-bus replay envelopes.")
];
const mcpPrompts = [
  {
    name: "kraken_dual_demo_brief",
    description: "Summarize the DUAL-governed Kraken paper-trading demo for a partner or reviewer.",
    arguments: []
  },
  {
    name: "kraken_dual_next_action",
    description: "Inspect status and return the next concrete operator step.",
    arguments: []
  }
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      await handleMcp(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: "server_error",
      message: error.message,
      detail: error.body || null
    });
  }
});

server.listen(port, host, () => {
  console.log(`DUAL x Kraken demo running at http://${host}:${port}`);
});

async function handleApi(req, res, url) {
  restoreDualSession(req);

  if (req.method === "GET" && (url.pathname === "/api/openapi.json" || url.pathname === "/api/v1/openapi.json")) {
    sendJson(res, 200, buildOpenApiDocument(req), noCacheHeaders());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, await buildHealth(req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/status") {
    sendJson(res, 200, publicDualStatus(req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/write-readiness") {
    sendJson(res, 200, publicWriteReadiness(req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/auth/status") {
    sendJson(res, 200, dualPersistence.authStatus());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/auth/request-code") {
    const body = await readBody(req);
    const result = await dualPersistence.requestEmailCode(body.email);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/auth/verify-code") {
    const body = await readBody(req);
    let sessionCookie = null;
    const result = await dualPersistence.verifyEmailCode(body.email, body.code, {
      onSession(session) {
        sessionCookie = createDualSessionCookie(session);
      }
    });
    sendJson(res, 200, result, sessionCookie ? { "set-cookie": sessionCookie } : {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/replay-queue") {
    const state = await loadState();
    sendJson(res, 200, publicReplayQueue(req, state.passport, state.audit || []));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/replay-queue/execute") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const state = await loadState();
    const readiness = publicWriteReadiness(req);
    if (!readiness.ready) {
      sendJson(res, 409, {
        executed: false,
        error: "dual_write_not_ready",
        readiness,
        replayQueue: publicReplayQueue(req, state.passport, state.audit || [])
      });
      return;
    }

    const result = await dualPersistence.executeReplayQueue(state.passport, state.audit || []);
    const syncedByEventId = new Map(result.events.map((event) => [event.eventId, event]));
    state.audit = (state.audit || []).map((event) => {
      const synced = syncedByEventId.get(event.id);
      if (!synced) return event;
      return {
        ...event,
        dualSync: {
          synced: true,
          envelopeHash: synced.envelopeHash,
          replayedAt: new Date().toISOString(),
          result: synced.result
        }
      };
    });
    await saveState(state);
    sendJson(res, 200, { executed: true, state, result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/passport") {
    const result = await dualPersistence.readPassportObject();
    sendJson(res, result.available ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/template-readback") {
    const result = await dualPersistence.readPassportTemplate();
    sendJson(res, result.available ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/proof") {
    const proof = await buildProofBundle(req);
    sendJson(res, 200, proof);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/proof/verify") {
    sendJson(res, 200, await buildProofVerification(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/template") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const result = await dualPersistence.createTemplate();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/action-passport/setup") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const body = await readBody(req);
    if (body.confirm !== "create-action-enabled-kraken-passport") {
      sendJson(res, 400, {
        error: "confirmation_required",
        message: "Send confirm=create-action-enabled-kraken-passport to create a persistent DUAL template and object."
      });
      return;
    }
    const state = await loadState();
    const result = await dualPersistence.createActionEnabledPassport(state.passport);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/sync-passport") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const state = await loadState();
    const result = await dualPersistence.syncPassport(state.passport, { source: "manual_sync" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/probe-update-schemas") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const body = await readBody(req);
    if (body.confirm !== "probe-dual-update-schemas") {
      sendJson(res, 400, {
        error: "confirmation_required",
        message: "Send confirm=probe-dual-update-schemas to run sanitized DUAL update schema probes."
      });
      return;
    }
    const state = await loadState();
    const result = await dualPersistence.probeUpdateSchemas(state.passport);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const state = await loadState();
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/policy") {
    const body = await readBody(req);
    const state = await loadState();
    const previousPolicy = policySnapshot(state.passport);
    const policy = normalizePolicy(body, state.passport);
    const policyVersion = Number(state.passport.policyVersion || 1) + 1;

    state.passport = {
      ...state.passport,
      ...policy,
      policyVersion,
      dualObjectState: "active"
    };
    state.passport.policyHash = hashJson(policySnapshot(state.passport));

    state.proposals = (state.proposals || []).map((proposal) => {
      if (proposal.state === "executed") return proposal;
      const nextPolicy = evaluateTrade(state.passport, {
        ...proposal.trade,
        approved: proposal.approved
      });
      return {
        ...proposal,
        policy: nextPolicy,
        state: nextPolicy.decision === "block"
          ? "blocked"
          : nextPolicy.decision === "needs_approval"
            ? "awaiting_approval"
            : "approved",
        approved: proposal.approved || nextPolicy.decision === "allow"
      };
    });

    const event = await addAudit(req, state,
      "policy_updated",
      "ok",
      "Policy updated",
      `DUAL mandate now allows ${state.passport.allowedPairs.join(", ")} with ${formatUsd(state.passport.maxNotionalUsd)} per-trade cap.`,
      {
        previousPolicy,
        policy: policySnapshot(state.passport)
      }
    );
    await saveState(state);
    sendJson(res, 200, { state, policy: policySnapshot(state.passport), event });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const state = await resetState();
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/market") {
    const pair = String(url.searchParams.get("pair") || "BTCUSD").toUpperCase();
    const { market } = await readMarketSnapshot(req, pair, { recordAudit: true });
    sendJson(res, 200, market);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/propose") {
    const body = await readBody(req);
    const { state, proposal } = await proposeTrade(req, body);
    sendJson(res, 200, { state, proposal });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approve") {
    const body = await readBody(req);
    const { state, proposal } = await approveTrade(req, body);
    sendJson(res, 200, { state, proposal });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execute-paper") {
    const body = await readBody(req);
    const result = await executePaperTradeProposal(req, body);
    sendJson(res, result.blocked ? 409 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/red-team") {
    const body = await readBody(req);
    sendJson(res, 200, await runRedTeam(req, body));
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function buildHealth(req) {
  const adapter = await getAdapterStatus();
  return {
    ok: true,
    app: {
      name: mcpServerInfo.name,
      version: appVersion,
      openapi: "/api/openapi.json",
      mcp: "/mcp"
    },
    safety: safetySummary(),
    adapter,
    dual: publicDualStatus(req)
  };
}

async function readMarketSnapshot(req, pair, { recordAudit = false } = {}) {
  const state = await loadState();
  state.market = state.market || {};
  const market = await getMarket(pair, state.market);
  state.market[market.pair || pair] = {
    price: market.price,
    changePct: market.changePct,
    volume: market.volume,
    source: market.source
  };
  let event = null;
  if (recordAudit) {
    event = await addAudit(req, state,
      "market_snapshot",
      "ok",
      `${market.pair || pair} market snapshot`,
      `${describeMarketSource(market.source)} returned ${market.pair || pair} at $${market.price}.`,
      { pair: market.pair || pair, source: market.source, price: market.price }
    );
    await saveState(state);
  }
  return { state, market, event };
}

async function proposeTrade(req, input) {
  const state = await loadState();
  state.market = state.market || {};
  state.proposals = state.proposals || [];
  const pair = String(input.pair || "BTCUSD").toUpperCase();
  const market = await getMarket(pair, state.market);
  state.market[pair] = {
    price: market.price,
    changePct: market.changePct,
    volume: market.volume,
    source: market.source
  };
  const trade = normalizeTrade({
    ...input,
    notional: input.notional ?? input.notional_usd ?? input.notionalUsd,
    price: market.price
  });
  const policy = evaluateTrade(state.passport, trade);
  const proposal = createProposal(trade, policy);
  state.proposals.unshift(proposal);
  state.passport.dualObjectState = proposal.state;
  const event = await addAudit(req, state,
    "trade_proposed",
    policy.decision === "block" ? "blocked" : "pending",
    policy.decision === "block" ? "Proposal blocked" : "Trade proposal created",
    describePolicy(trade, policy),
    { proposalId: proposal.id, trade, policy }
  );
  await saveState(state);
  return { state, proposal, market, event };
}

async function approveTrade(req, input) {
  const state = await loadState();
  const id = requireProposalId(input);
  const proposal = (state.proposals || []).find((item) => item.id === id);
  if (!proposal) throw httpError("Proposal not found.", 404, "proposal_not_found");

  proposal.approved = true;
  proposal.state = "approved";
  proposal.trade.approved = true;
  proposal.policy = evaluateTrade(state.passport, proposal.trade);
  state.passport.dualObjectState = "approved";
  const event = await addAudit(req, state,
    "human_approved",
    "ok",
    "Human approval recorded",
    `${proposal.trade.side.toUpperCase()} ${proposal.trade.quantity} ${proposal.trade.pair} approved under DUAL mandate.`,
    { proposalId: proposal.id }
  );
  await saveState(state);
  return { state, proposal, event };
}

async function executePaperTradeProposal(req, input) {
  const state = await loadState();
  const id = requireProposalId(input);
  const proposal = (state.proposals || []).find((item) => item.id === id);
  if (!proposal) throw httpError("Proposal not found.", 404, "proposal_not_found");

  const policy = evaluateTrade(state.passport, { ...proposal.trade, approved: proposal.approved });
  proposal.policy = policy;

  if (policy.decision !== "allow") {
    proposal.state = policy.decision === "needs_approval" ? "awaiting_approval" : policy.decision;
    state.passport.dualObjectState = policy.decision === "needs_approval" ? "awaiting_approval" : "blocked";
    await addAudit(req, state,
      "execution_blocked",
      "blocked",
      "Execution blocked by DUAL",
      describePolicy(proposal.trade, policy),
      { proposalId: proposal.id, policy }
    );
    await saveState(state);
    return { executed: false, blocked: true, state, proposal, policy };
  }

  const result = await executePaperTrade(proposal.trade);
  proposal.result = result;
  proposal.state = "executed";
  proposal.executedAt = new Date().toISOString();
  state.passport.dailyNotionalUsed = Math.round((state.passport.dailyNotionalUsed + policy.notional) * 100) / 100;
  state.passport.dualObjectState = "executed";
  await addAudit(req, state,
    "paper_executed",
    "ok",
    "Kraken paper trade executed",
    `${proposal.trade.side.toUpperCase()} ${proposal.trade.quantity} ${proposal.trade.pair} via ${result.source}.`,
    { proposalId: proposal.id, resultDigest: result.digest, source: result.source }
  );
  await saveState(state);
  return { executed: true, blocked: false, state, proposal, result };
}

async function proposeAndExecutePaperTrade(req, args) {
  const proposed = await proposeTrade(req, normalizeMcpTradeInput(args));
  if (proposed.proposal.policy.decision !== "allow") {
    return {
      ok: true,
      executed: false,
      status: proposed.proposal.policy.decision === "needs_approval" ? "requires_approval" : "blocked",
      proposal: proposed.proposal,
      market: proposed.market,
      summary: summarizeStateForAgent(proposed.state)
    };
  }
  const executed = await executePaperTradeProposal(req, { id: proposed.proposal.id });
  return {
    ok: true,
    status: "executed",
    proposal: executed.proposal,
    result: executed.result,
    summary: summarizeStateForAgent(executed.state)
  };
}

async function runRedTeam(req, input) {
  const state = await loadState();
  state.market = state.market || {};
  const trade = redTeamTrade(input.scenario, state.passport, state.market);
  const policy = evaluateTrade(state.passport, trade);
  const event = await addAudit(req, state,
    "red_team_check",
    policy.decision === "block" ? "blocked" : "warning",
    `${trade.label} tested`,
    describePolicy(trade, policy),
    { scenario: input.scenario, trade, policy }
  );
  state.passport.dualObjectState = policy.decision === "block" ? "blocked" : state.passport.dualObjectState;
  await saveState(state);
  return { state, trade, policy, event };
}

async function buildProofVerification(req) {
  const proof = await buildProofBundle(req);
  return verifyProofBundle(proof);
}

function verifyProofBundle(proof) {
  const validityChecks = proof.verification.filter((check) => check.requiredFor !== "completeness");
  const completenessChecks = proof.verification.filter((check) => check.requiredFor === "completeness");
  const ok = validityChecks.every((check) => check.ok);
  const complete = ok && completenessChecks.every((check) => check.ok);
  return {
    ok,
    complete,
    status: complete ? "complete" : ok ? "valid_with_pending_replay" : "failed",
    proofHash: proof.proofHash,
    auditRoot: proof.audit.rootHash,
    replayRoot: proof.replayQueue.rootHash,
    checks: proof.verification
  };
}

async function buildAgentStatus(req, args = {}) {
  const [state, adapter] = await Promise.all([loadState(), getAdapterStatus()]);
  const status = {
    ok: true,
    app: {
      name: mcpServerInfo.name,
      version: appVersion,
      openapi: `${requestOrigin(req)}/api/openapi.json`,
      mcp: `${requestOrigin(req)}/mcp`
    },
    safety: safetySummary(),
    adapter,
    dual: publicDualStatus(req),
    writeReadiness: publicWriteReadiness(req),
    summary: summarizeStateForAgent(state)
  };
  if (args.include_proof !== false) {
    status.proof = await buildProofVerification(req);
  }
  return status;
}

function summarizeStateForAgent(state, limit = 5) {
  const proposals = (state.proposals || []).slice(0, limit).map((proposal) => ({
    id: proposal.id,
    state: proposal.state,
    pair: proposal.trade?.pair,
    side: proposal.trade?.side,
    quantity: proposal.trade?.quantity,
    price: proposal.trade?.price,
    notional: proposal.policy?.notional,
    decision: proposal.policy?.decision,
    approved: proposal.approved,
    executedAt: proposal.executedAt,
    resultDigest: proposal.result?.digest || null
  }));
  const audit = (state.audit || []).slice(0, limit).map((event) => ({
    id: event.id,
    type: event.type,
    status: event.status,
    title: event.title,
    hash: event.provenanceHash || event.id,
    dualSync: event.dualSync || null,
    timestamp: event.timestamp
  }));
  return {
    passport: {
      id: state.passport.id,
      agentName: state.passport.agentName,
      mode: state.passport.mode,
      state: state.passport.dualObjectState || state.passport.state,
      allowedPairs: state.passport.allowedPairs,
      dailyNotionalUsed: state.passport.dailyNotionalUsed
    },
    policy: policySnapshot(state.passport),
    proposals,
    audit: {
      eventCount: (state.audit || []).length,
      latest: audit
    }
  };
}

function safetySummary() {
  return {
    tradingMode: "paper",
    liveKrakenTradingExposed: false,
    krakenApiKeysRequired: false,
    dualWrites: publicDualWrites ? "public_enabled_by_env" : "operator_gated",
    exposedMcpDualWriteTools: false,
    supportedPairs
  };
}

async function handleMcp(req, res) {
  let requestId = null;
  try {
    restoreDualSession(req);
    assertMcpOrigin(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...securityHeaders(),
        ...mcpCorsHeaders(req),
        ...mcpVersionHeaders(),
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id, x-demo-operator-token"
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      return sendMcpResponse(req, res, mcpError(null, -32600, "MCP endpoint accepts POST requests."), 405);
    }
    const message = await readMcpMessage(req);
    requestId = message?.id ?? null;
    if (!message || message.jsonrpc !== "2.0" || !message.method) {
      return sendMcpResponse(req, res, mcpError(requestId, -32600, "Invalid JSON-RPC request."));
    }
    if (message.id === undefined && message.method.startsWith("notifications/")) {
      res.writeHead(202, { ...securityHeaders(), ...mcpCorsHeaders(req), ...mcpVersionHeaders() });
      res.end();
      return;
    }
    const result = await handleMcpMethod(req, message.method, message.params || {});
    return sendMcpResponse(req, res, mcpResult(message.id, result));
  } catch (error) {
    return sendMcpResponse(req, res, mcpError(requestId, mcpJsonRpcErrorCode(error), error.message || "MCP server error.", {
      code: error.code || "mcp_error",
      detail: error.detail || null
    }), error.status && error.status >= 400 ? error.status : 200);
  }
}

async function handleMcpMethod(req, method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: mcpProtocolVersion,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      },
      serverInfo: mcpServerInfo,
      instructions: "Use the Kraken DUAL tools for paper trades only. DUAL governs approvals and audit proof; public MCP does not expose real Kraken orders or DUAL replay writes."
    };
  }
  if (method === "tools/list") return { tools: mcpTools };
  if (method === "resources/list") return { resources: mcpResources };
  if (method === "prompts/list") return { prompts: mcpPrompts };
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    try {
      return mcpJsonContent(await callMcpTool(req, name, args));
    } catch (error) {
      return mcpToolErrorContent(error, name, args);
    }
  }
  if (method === "resources/read") {
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: "application/json",
          text: JSON.stringify(await readMcpResource(req, params.uri), null, 2)
        }
      ]
    };
  }
  if (method === "prompts/get") return getMcpPrompt(params.name, params.arguments || {});
  throw Object.assign(new Error(`Unsupported MCP method: ${method}`), { code: "mcp_method_not_found" });
}

async function callMcpTool(req, name, args) {
  switch (name) {
    case "kraken_dual_get_status":
      return buildAgentStatus(req, args);
    case "kraken_dual_get_market": {
      const { market } = await readMarketSnapshot(req, requireSupportedPair(args.pair), { recordAudit: false });
      return { ok: true, market, safety: safetySummary() };
    }
    case "kraken_dual_propose_trade": {
      const result = await proposeTrade(req, normalizeMcpTradeInput(args));
      return {
        ok: true,
        status: result.proposal.state,
        proposal: result.proposal,
        market: result.market,
        summary: summarizeStateForAgent(result.state)
      };
    }
    case "kraken_dual_approve_trade": {
      const result = await approveTrade(req, { id: requireProposalId(args) });
      return {
        ok: true,
        status: result.proposal.state,
        proposal: result.proposal,
        summary: summarizeStateForAgent(result.state)
      };
    }
    case "kraken_dual_execute_paper_trade": {
      const result = await executePaperTradeProposal(req, { id: requireProposalId(args) });
      return {
        ok: true,
        status: result.blocked ? "blocked" : "executed",
        executed: result.executed,
        proposal: result.proposal,
        policy: result.policy || result.proposal.policy,
        result: result.result || null,
        summary: summarizeStateForAgent(result.state)
      };
    }
    case "kraken_dual_propose_and_execute_paper_trade":
      return proposeAndExecutePaperTrade(req, args);
    case "kraken_dual_get_proof":
      return { ok: true, proof: await buildProofBundle(req) };
    case "kraken_dual_verify_proof":
      return { ok: true, verification: await buildProofVerification(req) };
    case "kraken_dual_get_audit":
      return readAuditForAgent(args);
    case "kraken_dual_get_replay_queue": {
      const state = await loadState();
      return { ok: true, replayQueue: publicReplayQueue(req, state.passport, state.audit || []) };
    }
    case "kraken_dual_red_team": {
      const result = await runRedTeam(req, { scenario: args.scenario || "leverage" });
      return {
        ok: true,
        scenario: args.scenario || "leverage",
        trade: result.trade,
        policy: result.policy,
        event: result.event,
        summary: summarizeStateForAgent(result.state)
      };
    }
    default:
      throw Object.assign(new Error(`Unknown Kraken DUAL MCP tool: ${name}`), { code: "mcp_tool_not_found", status: 404 });
  }
}

async function readMcpResource(req, uri) {
  if (uri === "kraken-dual://status") return buildAgentStatus(req);
  if (uri === "kraken-dual://proof") return buildProofBundle(req);
  if (uri === "kraken-dual://audit") return readAuditForAgent({ limit: 20 });
  if (uri === "kraken-dual://replay-queue") {
    const state = await loadState();
    return { ok: true, replayQueue: publicReplayQueue(req, state.passport, state.audit || []) };
  }
  throw Object.assign(new Error(`Unknown Kraken DUAL MCP resource: ${uri}`), { code: "mcp_resource_not_found", status: 404 });
}

function getMcpPrompt(name, args) {
  if (name === "kraken_dual_demo_brief") {
    return {
      description: "Kraken DUAL demo brief",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Summarize the DUAL x Kraken paper-trading demo. Keep the distinction clear: Kraken supplies market/execution rails, DUAL supplies policy, approval, audit, proof, and replay-gated persistence."
        }
      }]
    };
  }
  if (name === "kraken_dual_next_action") {
    return {
      description: "Kraken DUAL next action",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Inspect Kraken DUAL status and return the next concrete operator step. Target pair: ${args.pair || "DUALUSD"}. Keep public paper trading, DUAL write readiness, and proof completeness separate.`
        }
      }]
    };
  }
  throw Object.assign(new Error(`Unknown Kraken DUAL MCP prompt: ${name}`), { code: "mcp_prompt_not_found", status: 404 });
}

async function readAuditForAgent(args = {}) {
  const state = await loadState();
  const limit = clampInteger(args.limit, 1, 50, 10);
  return {
    ok: true,
    audit: {
      eventCount: (state.audit || []).length,
      latest: (state.audit || []).slice(0, limit).map((event) => ({
        id: event.id,
        type: event.type,
        status: event.status,
        title: event.title,
        detail: event.detail,
        hash: event.provenanceHash || event.id,
        dualSync: event.dualSync || null,
        timestamp: event.timestamp
      }))
    }
  };
}

function mcpTool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

function mcpResource(uri, name, description) {
  return { uri, name, description, mimeType: "application/json" };
}

async function readMcpMessage(req) {
  try {
    return await readBody(req);
  } catch {
    throw httpError("Request body must be valid JSON.", 400, "invalid_json");
  }
}

function sendMcpResponse(req, res, payload, status = 200) {
  res.writeHead(status, {
    ...securityHeaders(),
    ...mcpCorsHeaders(req),
    ...mcpVersionHeaders(),
    "content-type": "application/json; charset=utf-8",
    "mcp-session-id": mcpSessionId(req)
  });
  res.end(JSON.stringify(payload, null, 2));
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, code, message, data = null) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function mcpJsonContent(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function mcpToolErrorContent(error, name, args) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          tool_name: name || null,
          error: {
            code: error.code || "mcp_tool_failed",
            message: error.message || "Kraken DUAL MCP tool failed.",
            status: error.status || null,
            detail: error.detail || null
          },
          retryable: [408, 429, 500, 502, 503, 504].includes(Number(error.status)),
          arguments: redactMcpArguments(args)
        }, null, 2)
      }
    ]
  };
}

function assertMcpOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = (process.env.DEMO_MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowed.includes("*") || allowed.includes(origin)) return;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = "";
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (originHost && host && originHost === host) return;
  if (originHost.startsWith("127.0.0.1") || originHost.startsWith("localhost")) return;
  throw httpError("MCP origin is not allowed.", 403, "mcp_origin_denied");
}

function mcpCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "mcp-session-id, x-kraken-dual-version, x-mcp-protocol-version, x-mcp-schema-version",
    vary: "origin"
  };
}

function mcpVersionHeaders() {
  return {
    ...noCacheHeaders(),
    "x-kraken-dual-version": appVersion,
    "x-mcp-protocol-version": mcpProtocolVersion,
    "x-mcp-schema-version": `${appVersion}:${mcpTools.length}`
  };
}

function mcpJsonRpcErrorCode(error) {
  if (error.code === "mcp_method_not_found") return -32601;
  if (error.status === 400 || error.code === "argument_required") return -32602;
  return -32000;
}

function mcpSessionId(req) {
  const supplied = String(req.headers["mcp-session-id"] || "").trim();
  if (/^[a-zA-Z0-9._:-]{4,128}$/.test(supplied)) return supplied;
  const fingerprint = [
    req.headers["x-forwarded-host"] || req.headers.host || "",
    req.headers.origin || "",
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
    req.headers["user-agent"] || ""
  ].join("|");
  return `mcp-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 18)}`;
}

function redactMcpArguments(args = {}) {
  if (!args || typeof args !== "object") return {};
  const redacted = { ...args };
  for (const key of Object.keys(redacted)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) redacted[key] = "[REDACTED]";
  }
  return redacted;
}

function buildOpenApiDocument(req) {
  const origin = requestOrigin(req) || "http://localhost:4173";
  const jsonResponse = {
    description: "JSON response.",
    content: {
      "application/json": {
        schema: { type: "object", additionalProperties: true }
      }
    }
  };
  const requestBody = (schema) => ({
    required: true,
    content: { "application/json": { schema } }
  });
  const tradeRequestSchema = {
    type: "object",
    required: ["pair", "side", "notional"],
    additionalProperties: false,
    properties: {
      pair: tradePairSchema,
      side: tradeSideSchema,
      notional: tradeNotionalSchema,
      approved: { type: "boolean", default: false }
    }
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "DUAL x Kraken Agent Trading Passport API",
      version: appVersion,
      description: "Safe paper-trading API where Kraken supplies market/execution rails and DUAL supplies policy, approval, audit, proof, and gated persistence."
    },
    servers: [{ url: origin }],
    paths: {
      "/api/health": {
        get: { summary: "Read demo health and integration status.", responses: { 200: jsonResponse } }
      },
      "/api/openapi.json": {
        get: { summary: "Read this OpenAPI description.", responses: { 200: jsonResponse } }
      },
      "/api/dual/status": {
        get: { summary: "Read public DUAL adapter status and write gate state.", responses: { 200: jsonResponse } }
      },
      "/api/dual/write-readiness": {
        get: { summary: "Read whether DUAL writes are ready for this request.", responses: { 200: jsonResponse } }
      },
      "/api/dual/replay-queue": {
        get: { summary: "Read DUAL event-bus replay envelopes.", responses: { 200: jsonResponse } }
      },
      "/api/proof": {
        get: { summary: "Read portable proof bundle.", responses: { 200: jsonResponse } }
      },
      "/api/proof/verify": {
        get: { summary: "Verify current proof bundle.", responses: { 200: jsonResponse } }
      },
      "/api/state": {
        get: { summary: "Read local demo state.", responses: { 200: jsonResponse } }
      },
      "/api/market": {
        get: {
          summary: "Read market data for a supported pair.",
          parameters: [{
            name: "pair",
            in: "query",
            schema: tradePairSchema,
            required: false
          }],
          responses: { 200: jsonResponse }
        }
      },
      "/api/policy": {
        post: {
          summary: "Update the local DUAL trading policy.",
          requestBody: requestBody({
            type: "object",
            required: ["allowedPairs", "maxNotionalUsd", "maxDailyNotionalUsd", "humanApprovalRequiredAbove", "leverageAllowed"],
            properties: {
              allowedPairs: { type: "array", items: tradePairSchema },
              maxNotionalUsd: { type: "number", minimum: 1 },
              maxDailyNotionalUsd: { type: "number", minimum: 1 },
              humanApprovalRequiredAbove: { type: "number", minimum: 0 },
              leverageAllowed: { type: "boolean" }
            }
          }),
          responses: { 200: jsonResponse }
        }
      },
      "/api/propose": {
        post: {
          summary: "Create a DUAL policy-checked paper trade proposal.",
          requestBody: requestBody(tradeRequestSchema),
          responses: { 200: jsonResponse }
        }
      },
      "/api/approve": {
        post: {
          summary: "Approve a waiting paper trade proposal.",
          requestBody: requestBody({
            type: "object",
            required: ["id"],
            properties: { id: proposalIdSchema }
          }),
          responses: { 200: jsonResponse, 404: jsonResponse }
        }
      },
      "/api/execute-paper": {
        post: {
          summary: "Execute an approved proposal through paper/simulator rails.",
          requestBody: requestBody({
            type: "object",
            required: ["id"],
            properties: { id: proposalIdSchema }
          }),
          responses: { 200: jsonResponse, 409: jsonResponse, 404: jsonResponse }
        }
      },
      "/api/red-team": {
        post: {
          summary: "Run a safe policy-violation scenario.",
          requestBody: requestBody({
            type: "object",
            required: ["scenario"],
            properties: {
              scenario: { type: "string", enum: ["oversized", "blocked_pair", "leverage", "missing_approval"] }
            }
          }),
          responses: { 200: jsonResponse }
        }
      },
      "/mcp": {
        post: {
          summary: "MCP JSON-RPC facade for paper-trading tools, proof resources, and demo prompts.",
          requestBody: requestBody({
            type: "object",
            required: ["jsonrpc", "method"],
            properties: {
              jsonrpc: { type: "string", const: "2.0" },
              id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
              method: { type: "string" },
              params: { type: "object", additionalProperties: true }
            }
          }),
          responses: { 200: jsonResponse, 405: jsonResponse }
        },
        options: {
          summary: "MCP CORS preflight.",
          responses: { 204: { description: "No content." } }
        }
      }
    },
    components: {
      securitySchemes: {
        demoOperatorToken: { type: "apiKey", in: "header", name: "x-demo-operator-token" },
        bearerOperatorToken: { type: "http", scheme: "bearer" }
      }
    },
    "x-mcp": {
      endpoint: `${origin}/mcp`,
      protocolVersion: mcpProtocolVersion,
      serverInfo: mcpServerInfo,
      tools: mcpTools.map((tool) => tool.name),
      resources: mcpResources.map((resource) => resource.uri)
    },
    "x-safety": safetySummary()
  };
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  if (!body) return {};
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  return JSON.parse(body);
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

function noCacheHeaders() {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    expires: "0"
  };
}

function requestOrigin(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || req.headers.host || "";
  if (!host) return "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req.socket?.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json"
  }[extname(filePath)] || "application/octet-stream";
}

function normalizeMcpTradeInput(args = {}) {
  return {
    pair: requireSupportedPair(args.pair),
    side: requireTradeSide(args.side),
    notional: parseMcpNotional(args.notional_usd),
    approved: Boolean(args.approved)
  };
}

function requireSupportedPair(value) {
  const pair = String(value || "DUALUSD").toUpperCase();
  if (!supportedPairs.includes(pair)) {
    throw httpError(`Unsupported pair ${pair}.`, 400, "unsupported_pair", { supportedPairs });
  }
  return pair;
}

function requireTradeSide(value) {
  const side = String(value || "buy").toLowerCase();
  if (!["buy", "sell"].includes(side)) {
    throw httpError("side must be buy or sell.", 400, "unsupported_side");
  }
  return side;
}

function parseMcpNotional(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError("notional_usd must be greater than zero.", 400, "invalid_notional");
  }
  return roundMoney(amount);
}

function requireProposalId(input = {}) {
  const id = String(input.proposal_id || input.id || "").trim();
  if (!id) throw httpError("proposal_id is required.", 400, "argument_required");
  return id;
}

function clampInteger(value, min, max, fallback) {
  const amount = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(amount)) return fallback;
  return Math.max(min, Math.min(max, amount));
}

function httpError(message, status = 400, code = "bad_request", detail = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}

function normalizeTrade(input) {
  const pair = String(input.pair || "BTCUSD").toUpperCase();
  const side = String(input.side || "buy").toLowerCase();
  const price = Number(input.price || 0);
  const notional = Number(input.notional || input.notionalUsd || 75);
  const quantity = Number(input.quantity || roundQty(notional / price));

  return {
    pair,
    side,
    price,
    quantity,
    leverage: Number(input.leverage || 1),
    approved: Boolean(input.approved)
  };
}

function normalizePolicy(input, currentPassport) {
  const allowedPairs = normalizeAllowedPairs(input.allowedPairs);
  const maxNotionalUsd = parsePositiveMoney(input.maxNotionalUsd, "Max trade");
  const maxDailyNotionalUsd = parsePositiveMoney(input.maxDailyNotionalUsd, "Daily cap");
  const humanApprovalRequiredAbove = parseNonNegativeMoney(input.humanApprovalRequiredAbove, "Approval threshold");
  const leverageAllowed = parseBoolean(input.leverageAllowed);

  if (maxDailyNotionalUsd < maxNotionalUsd) {
    const error = new Error("Daily cap must be at least the max trade amount.");
    error.status = 400;
    throw error;
  }

  const blockedActions = new Set(currentPassport.blockedActions || []);
  blockedActions.add("live_order");
  blockedActions.add("unsupported_pair");
  blockedActions.add("over_limit");
  blockedActions.add("missing_approval");
  if (leverageAllowed) {
    blockedActions.delete("leverage");
  } else {
    blockedActions.add("leverage");
  }

  return {
    allowedPairs,
    maxNotionalUsd,
    maxDailyNotionalUsd,
    humanApprovalRequiredAbove,
    leverageAllowed,
    blockedActions: [...blockedActions],
    approvalPolicy: "human_required_above_threshold"
  };
}

function normalizeAllowedPairs(input) {
  const supportedPairSet = new Set(supportedPairs);
  const values = Array.isArray(input)
    ? input
    : String(input || "").split(/[\s,]+/);
  const allowedPairs = [...new Set(values
    .map((pair) => String(pair || "").trim().toUpperCase())
    .filter((pair) => supportedPairSet.has(pair)))];
  if (!allowedPairs.length) {
    const error = new Error("Select at least one supported pair.");
    error.status = 400;
    throw error;
  }
  return allowedPairs;
}

function parsePositiveMoney(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(`${label} must be greater than zero.`);
    error.status = 400;
    throw error;
  }
  return roundMoney(amount);
}

function parseNonNegativeMoney(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error(`${label} must be zero or greater.`);
    error.status = 400;
    throw error;
  }
  return roundMoney(amount);
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function policySnapshot(passport) {
  return {
    allowedPairs: passport.allowedPairs,
    maxNotionalUsd: passport.maxNotionalUsd,
    maxDailyNotionalUsd: passport.maxDailyNotionalUsd,
    leverageAllowed: passport.leverageAllowed,
    humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove,
    blockedActions: passport.blockedActions,
    approvalPolicy: passport.approvalPolicy,
    policyVersion: passport.policyVersion || 1
  };
}

function formatUsd(value) {
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function describePolicy(trade, policy) {
  if (policy.decision === "allow") {
    return `DUAL policy allowed ${trade.side.toUpperCase()} ${trade.quantity} ${trade.pair} for $${policy.notional}.`;
  }
  if (policy.decision === "needs_approval") {
    return `DUAL requires approval: ${policy.warnings.join(" ")}`;
  }
  return `DUAL blocked action: ${policy.violations.join(" ")}`;
}

function publicDualStatus(req) {
  const status = dualPersistence.status();
  const gate = dualWriteGate(req);
  if (!status.writable || gate.allowed) {
    return { ...status, writeGate: gate };
  }
  return {
    ...status,
    serverWritable: true,
    writable: false,
    writeGate: gate,
    detail: gate.configured
      ? "DUAL is read-linked for this request. Server-side writes require operator authorization."
      : "DUAL is read-linked. Server-side writes are disabled until DEMO_OPERATOR_TOKEN is configured."
  };
}

function publicWriteReadiness(req) {
  const readiness = dualPersistence.writeReadiness();
  const gate = dualWriteGate(req);
  if (!readiness.ready || gate.allowed) {
    return { ...readiness, writeGate: gate };
  }
  return {
    ...readiness,
    ready: false,
    writeGate: gate,
    missing: [...new Set([...(readiness.missing || []), "operator authorization"])],
    detail: gate.configured
      ? "DUAL write sync is available only for authenticated operator requests."
      : "DUAL write sync is disabled for public requests until DEMO_OPERATOR_TOKEN is configured."
  };
}

function publicReplayQueue(req, passport, audit) {
  const queue = dualPersistence.buildReplayQueue(passport, audit);
  return {
    ...queue,
    writable: Boolean(queue.writable && publicWriteReadiness(req).ready)
  };
}

function canUseDualWrite(req) {
  const auth = dualPersistence.authStatus();
  return publicDualWrites || operatorAuthorized(req) || auth.authType === "email_session";
}

function dualWriteGate(req) {
  return {
    required: true,
    configured: Boolean(operatorToken) || publicDualWrites,
    allowed: canUseDualWrite(req),
    publicWritesEnabled: publicDualWrites,
    authHeader: "x-demo-operator-token",
    detail: publicDualWrites
      ? "Public DUAL writes are explicitly enabled."
      : operatorToken
        ? "Send x-demo-operator-token or Authorization: Bearer <token> for DUAL write endpoints."
        : "Set DEMO_OPERATOR_TOKEN to enable authenticated DUAL write endpoints."
  };
}

function dualWriteForbidden(req) {
  return {
    executed: false,
    error: "operator_authorization_required",
    writeGate: dualWriteGate(req),
    detail: "This public demo can read and verify DUAL proof without an operator token, but DUAL writes are gated."
  };
}

function operatorAuthorized(req) {
  if (!operatorToken) return false;
  const headerToken = String(req.headers["x-demo-operator-token"] || "");
  const auth = String(req.headers.authorization || "");
  const bearerToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return timingSafeEqualText(headerToken, operatorToken) || timingSafeEqualText(bearerToken, operatorToken);
}

function timingSafeEqualText(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function buildProofBundle(req) {
  const [state, adapter] = await Promise.all([loadState(), getAdapterStatus()]);
  let dualObject = null;
  let dualTemplate = null;
  let dualBatch = null;
  try {
    dualObject = await dualPersistence.readPassportObject();
  } catch (error) {
    dualObject = { available: false, error: error.message };
  }
  try {
    dualTemplate = await dualPersistence.readPassportTemplate();
  } catch (error) {
    dualTemplate = { available: false, error: error.message };
  }
  try {
    dualBatch = await dualPersistence.readLatestBatchProof();
  } catch (error) {
    dualBatch = { available: false, error: error.message };
  }

  const audit = state.audit || [];
  const replayQueue = publicReplayQueue(req, state.passport, audit);
  const dualStatus = publicDualStatus(req);
  const writeReadiness = publicWriteReadiness(req);
  const templateFields = dualTemplate?.custom || {};
  const objectCustom = dualObject?.custom || {};
  const expectedPolicyHash = state.passport.policyHash || hashJson(policySnapshot(state.passport));
  const dualPolicyAuthoritative = Boolean(objectCustom.policy_version && objectCustom.policy_hash);
  const requiredMandateFields = [
    "passport_id",
    "agent_name",
    "mode",
    "state",
    "allowed_pairs",
    "max_notional_usd",
    "max_daily_notional_usd",
    "leverage_allowed",
    "approval_policy",
    "last_event_id"
  ];
  const templateHasMandateSchema = Boolean(
    dualTemplate?.available && requiredMandateFields.every((field) => Object.hasOwn(templateFields, field))
  );
  const objectMatchesPassport = Boolean(
    dualObject?.available
      && objectCustom.agent_name === state.passport.agentName
      && objectCustom.passport_id === state.passport.id
      && objectCustom.mode === state.passport.mode
      && (dualPolicyAuthoritative || (
        arraysEqualIgnoreOrder(objectCustom.allowed_pairs || [], state.passport.allowedPairs)
        && objectCustom.max_notional_usd === String(state.passport.maxNotionalUsd)
        && objectCustom.max_daily_notional_usd === String(state.passport.maxDailyNotionalUsd)
        && objectCustom.human_approval_required_above === String(state.passport.humanApprovalRequiredAbove)
        && objectCustom.leverage_allowed === String(state.passport.leverageAllowed)
        && objectCustom.approval_policy === state.passport.approvalPolicy
        && objectCustom.policy_version === String(state.passport.policyVersion || 1)
        && objectCustom.policy_hash === expectedPolicyHash
      ))
  );
  const durableDualWrite = Boolean(
    dualObject?.available
      && objectCustom.last_event_id
      && objectCustom.last_event_hash
      && (dualPolicyAuthoritative || objectCustom.policy_hash === expectedPolicyHash)
  );
  const syncedAuditEvents = audit.filter((event) => (
    event.dualSync?.synced && event.dualSync?.result?.actionId
  )).length;
  const auditRoot = hashJson(audit.map((event) => ({
    id: event.id,
    type: event.type,
    status: event.status,
    hash: event.provenanceHash || event.id,
    dualSync: event.dualSync || null
  })));

  const verification = [
    {
      id: "kraken-market-source",
      ok: adapter.source === "kraken-cli" || adapter.source === "kraken-public-api",
      detail: `Market source is ${adapter.source}.`
    },
    {
      id: "dual-read-link",
      ok: Boolean(dualObject?.available && dualObject.id === dualStatus.objectId),
      detail: dualObject?.available ? `DUAL object ${dualObject.id} is readable.` : "DUAL object is not readable."
    },
    {
      id: "dual-mandate-template",
      ok: templateHasMandateSchema,
      detail: dualTemplate?.available ? "DUAL template exposes the Kraken agent mandate schema." : "DUAL template is not readable."
    },
    {
      id: "dual-object-readback",
      ok: objectMatchesPassport,
      detail: dualObject?.available ? "DUAL object custom data matches the local passport mandate." : "DUAL object is not readable."
    },
    {
      id: "dual-event-bus-sync",
      ok: Boolean((audit.length && syncedAuditEvents === audit.length) || durableDualWrite),
      detail: syncedAuditEvents === audit.length
        ? `${syncedAuditEvents}/${audit.length} audit events have DUAL event-bus action ids.`
        : `DUAL object has durable event pointer ${objectCustom.last_event_id || "pending"}; ${syncedAuditEvents}/${audit.length} local audit events retain action ids.`
    },
    {
      id: "replay-queue",
      ok: Boolean(replayQueue.ready && replayQueue.rootHash),
      detail: replayQueue.writable
        ? `${replayQueue.pendingCount}/${replayQueue.eventCount} event-bus envelopes are pending with write auth active.`
        : `${replayQueue.pendingCount}/${replayQueue.eventCount} event-bus envelopes are pending until write auth is available.`
    },
    {
      id: "replay-complete",
      ok: Boolean(replayQueue.pendingCount === 0 || syncedAuditEvents === audit.length),
      requiredFor: "completeness",
      detail: replayQueue.pendingCount
        ? `${replayQueue.pendingCount}/${replayQueue.eventCount} event-bus envelopes still need replay.`
        : "No replay envelopes are pending."
    },
    {
      id: "dual-batch-status",
      ok: Boolean(dualBatch?.available && dualBatch.finality !== "failed"),
      detail: dualBatch?.available
        ? `Latest DUAL batch ${dualBatch.id} is ${dualBatch.status || dualBatch.finality}; proof ${dualBatch.proofValue || "pending"}.`
        : "DUAL sequencer batch status is not readable."
    }
  ];

  const payload = {
    schemaVersion: "dual-kraken-proof.v2",
    demo: "DUAL x Kraken Agent Trading Passport",
    status: {
      krakenMarketData: adapter.source,
      krakenPaperExecution: adapter.krakenCliAvailable ? "kraken-cli-paper" : "simulated-paper",
      dualMode: dualStatus,
      writeReadiness
    },
    dualTemplate,
    dualObject,
    dualBatch,
    replayQueue: {
      ready: replayQueue.ready,
      writable: replayQueue.writable,
      eventCount: replayQueue.eventCount,
      syncedCount: replayQueue.syncedCount,
      pendingCount: replayQueue.pendingCount,
      rootHash: replayQueue.rootHash,
      pendingRootHash: replayQueue.pendingRootHash,
      targetObjectId: replayQueue.targetObjectId,
      latest: replayQueue.allEvents.slice(0, 8),
      pending: replayQueue.events.slice(0, 8)
    },
    passport: {
      id: state.passport.id,
      agentName: state.passport.agentName,
      mode: state.passport.mode,
      state: state.passport.dualObjectState || state.passport.state,
      allowedPairs: state.passport.allowedPairs
    },
    policy: {
      version: dualPolicyAuthoritative ? Number(objectCustom.policy_version) : state.passport.policyVersion || 1,
      hash: dualPolicyAuthoritative ? objectCustom.policy_hash : state.passport.policyHash || hashJson(policySnapshot(state.passport)),
      allowedPairs: dualPolicyAuthoritative ? objectCustom.allowed_pairs || [] : state.passport.allowedPairs,
      maxNotionalUsd: dualPolicyAuthoritative ? Number(objectCustom.max_notional_usd) : state.passport.maxNotionalUsd,
      maxDailyNotionalUsd: dualPolicyAuthoritative ? Number(objectCustom.max_daily_notional_usd) : state.passport.maxDailyNotionalUsd,
      leverageAllowed: dualPolicyAuthoritative ? objectCustom.leverage_allowed === "true" : state.passport.leverageAllowed,
      humanApprovalRequiredAbove: dualPolicyAuthoritative ? Number(objectCustom.human_approval_required_above) : state.passport.humanApprovalRequiredAbove
    },
    audit: {
      eventCount: audit.length,
      rootHash: auditRoot,
      latest: audit.slice(0, 8).map((event) => ({
        id: event.id,
        type: event.type,
        status: event.status,
        hash: event.provenanceHash || event.id,
        dualSync: event.dualSync || null,
        timestamp: event.timestamp
      }))
    },
    caveats: [
      adapter.krakenCliAvailable ? "Kraken paper execution is CLI-backed." : "Kraken paper execution is simulated because Kraken CLI is unavailable in this runtime.",
      writeReadiness.ready ? "DUAL event-bus writes are enabled for this request." : "DUAL is read-linked; event-bus writes require an authenticated operator request."
    ],
    verification
  };

  return {
    generatedAt: new Date().toISOString(),
    ...payload,
    proofHash: hashJson(payload)
  };
}

function describeMarketSource(source) {
  if (source === "kraken-cli") return "Kraken CLI";
  if (source === "kraken-public-api") return "Kraken public API";
  return "Simulator";
}

async function addAudit(req, state, type, status, title, detail, payload = {}) {
  const event = createAuditEvent(type, status, title, detail, payload);
  try {
    if (canUseDualWrite(req)) {
      const dualResult = await dualPersistence.recordEvent(state.passport, event);
      event.dualSync = dualResult?.skipped
        ? { synced: false, reason: dualResult.reason, replay: dualResult.replay || null }
        : { synced: true, envelopeHash: dualResult?.envelopeHash || null, result: dualResult?.result || null };
    } else {
      event.dualSync = {
        synced: false,
        reason: "DUAL write sync is operator-gated for public demo requests."
      };
    }
  } catch (error) {
    event.dualSync = { synced: false, error: error.message };
  }
  state.audit.unshift(event);
  return event;
}

function hashJson(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function arraysEqualIgnoreOrder(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

function restoreDualSession(req) {
  dualPersistence.clearEmailSession?.();
  const sealed = readCookie(req.headers.cookie || "", dualSessionCookieName);
  if (!sealed) return;
  const session = unsealDualSession(sealed);
  if (session) dualPersistence.restoreEmailSession(session);
}

function createDualSessionCookie(session) {
  const sealed = sealDualSession({
    ...session,
    expiresAt: Date.now() + 60 * 60 * 1000
  });
  return `${dualSessionCookieName}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
}

function sealDualSession(session) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dualSessionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function unsealDualSession(sealed) {
  try {
    const [ivText, tagText, encryptedText] = String(sealed).split(".");
    if (!ivText || !tagText || !encryptedText) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", dualSessionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final()
    ]);
    const session = JSON.parse(decrypted.toString("utf8"));
    if (!session.expiresAt || Date.now() > Number(session.expiresAt)) return null;
    return session;
  } catch {
    return null;
  }
}

function dualSessionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.DUAL_SESSION_SECRET || process.env.DUAL_API_KEY || "kraken-dual-agent-demo-dev-session")
    .digest();
}

function readCookie(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;
}

async function loadDotEnv() {
  try {
    const envText = await readFile(join(root, ".env"), "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equals = trimmed.indexOf("=");
      if (equals === -1) continue;
      const key = trimmed.slice(0, equals).trim();
      const value = trimmed.slice(equals + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}
