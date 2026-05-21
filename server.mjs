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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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

  if (req.method === "GET" && url.pathname === "/api/health") {
    const adapter = await getAdapterStatus();
    sendJson(res, 200, { ok: true, adapter, dual: publicDualStatus(req) });
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
    const proof = await buildProofBundle(req);
    const validityChecks = proof.verification.filter((check) => check.requiredFor !== "completeness");
    const completenessChecks = proof.verification.filter((check) => check.requiredFor === "completeness");
    const ok = validityChecks.every((check) => check.ok);
    const complete = ok && completenessChecks.every((check) => check.ok);
    sendJson(res, 200, {
      ok,
      complete,
      status: complete ? "complete" : ok ? "valid_with_pending_replay" : "failed",
      proofHash: proof.proofHash,
      auditRoot: proof.audit.rootHash,
      replayRoot: proof.replayQueue.rootHash,
      checks: proof.verification
    });
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
    const state = await loadState();
    const pair = String(url.searchParams.get("pair") || "BTCUSD").toUpperCase();
    const market = await getMarket(pair, state.market);
    state.market[pair] = {
      price: market.price,
      changePct: market.changePct,
      volume: market.volume,
      source: market.source
    };
    await addAudit(req, state,
      "market_snapshot",
      "ok",
      `${pair} market snapshot`,
      `${describeMarketSource(market.source)} returned ${pair} at $${market.price}.`,
      { pair, source: market.source, price: market.price }
    );
    await saveState(state);
    sendJson(res, 200, market);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/propose") {
    const body = await readBody(req);
    const state = await loadState();
    const market = await getMarket(body.pair, state.market);
    const trade = normalizeTrade({ ...body, price: market.price });
    const policy = evaluateTrade(state.passport, trade);
    const proposal = createProposal(trade, policy);
    state.proposals.unshift(proposal);
    state.passport.dualObjectState = proposal.state;
    await addAudit(req, state,
      "trade_proposed",
      policy.decision === "block" ? "blocked" : "pending",
      policy.decision === "block" ? "Proposal blocked" : "Trade proposal created",
      describePolicy(trade, policy),
      { proposalId: proposal.id, trade, policy }
    );
    await saveState(state);
    sendJson(res, 200, { state, proposal });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approve") {
    const body = await readBody(req);
    const state = await loadState();
    const proposal = state.proposals.find((item) => item.id === body.id);
    if (!proposal) return sendJson(res, 404, { error: "proposal_not_found" });

    proposal.approved = true;
    proposal.state = "approved";
    proposal.trade.approved = true;
    proposal.policy = evaluateTrade(state.passport, proposal.trade);
    state.passport.dualObjectState = "approved";
    await addAudit(req, state,
      "human_approved",
      "ok",
      "Human approval recorded",
      `${proposal.trade.side.toUpperCase()} ${proposal.trade.quantity} ${proposal.trade.pair} approved under DUAL mandate.`,
      { proposalId: proposal.id }
    );
    await saveState(state);
    sendJson(res, 200, { state, proposal });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execute-paper") {
    const body = await readBody(req);
    const state = await loadState();
    const proposal = state.proposals.find((item) => item.id === body.id);
    if (!proposal) return sendJson(res, 404, { error: "proposal_not_found" });

    const policy = evaluateTrade(state.passport, { ...proposal.trade, approved: proposal.approved });
    proposal.policy = policy;

    if (policy.decision !== "allow") {
      proposal.state = policy.decision;
      state.passport.dualObjectState = "blocked";
      await addAudit(req, state,
        "execution_blocked",
        "blocked",
        "Execution blocked by DUAL",
        describePolicy(proposal.trade, policy),
        { proposalId: proposal.id, policy }
      );
      await saveState(state);
      sendJson(res, 409, { state, proposal, policy });
      return;
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
    sendJson(res, 200, { state, proposal, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/red-team") {
    const body = await readBody(req);
    const state = await loadState();
    const trade = redTeamTrade(body.scenario, state.passport, state.market);
    const policy = evaluateTrade(state.passport, trade);
    const event = await addAudit(req, state,
      "red_team_check",
      policy.decision === "block" ? "blocked" : "warning",
      `${trade.label} tested`,
      describePolicy(trade, policy),
      { scenario: body.scenario, trade, policy }
    );
    state.passport.dualObjectState = policy.decision === "block" ? "blocked" : state.passport.dualObjectState;
    await saveState(state);
    sendJson(res, 200, { state, trade, policy, event });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
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
