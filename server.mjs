import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadState, resetState, saveState, createAuditEvent, createProposal } from "./src/dualStore.mjs";
import { evaluateTrade, redTeamTrade, roundQty } from "./src/policy.mjs";
import { executePaperTrade, getAdapterStatus, getMarket } from "./src/krakenAdapter.mjs";
import { createDualPersistence } from "./src/dualPersistence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const publicDir = join(root, "public");
await loadDotEnv();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const dualPersistence = await createDualPersistence();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, { error: "server_error", message: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`DUAL x Kraken demo running at http://${host}:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const adapter = await getAdapterStatus();
    sendJson(res, 200, { ok: true, adapter, dual: dualPersistence.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/status") {
    sendJson(res, 200, dualPersistence.status());
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
    const proof = await buildProofBundle();
    sendJson(res, 200, proof);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/template") {
    const result = await dualPersistence.createTemplate();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/sync-passport") {
    const state = await loadState();
    const result = await dualPersistence.syncPassport(state.passport, { source: "manual_sync" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const state = await loadState();
    sendJson(res, 200, state);
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
    await addAudit(state,
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
    await addAudit(state,
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
    await addAudit(state,
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
      await addAudit(state,
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
    await addAudit(state,
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
    const event = await addAudit(state,
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
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
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

function describePolicy(trade, policy) {
  if (policy.decision === "allow") {
    return `DUAL policy allowed ${trade.side.toUpperCase()} ${trade.quantity} ${trade.pair} for $${policy.notional}.`;
  }
  if (policy.decision === "needs_approval") {
    return `DUAL requires approval: ${policy.warnings.join(" ")}`;
  }
  return `DUAL blocked action: ${policy.violations.join(" ")}`;
}

async function buildProofBundle() {
  const [state, adapter] = await Promise.all([loadState(), getAdapterStatus()]);
  let dualObject = null;
  let dualTemplate = null;
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

  const audit = state.audit || [];
  const auditRoot = hashJson(audit.map((event) => ({
    id: event.id,
    type: event.type,
    status: event.status,
    hash: event.provenanceHash || event.id,
    dualSync: event.dualSync || null
  })));

  const payload = {
    generatedAt: new Date().toISOString(),
    demo: "DUAL x Kraken Agent Trading Passport",
    status: {
      krakenMarketData: adapter.source,
      krakenPaperExecution: adapter.krakenCliAvailable ? "kraken-cli-paper" : "simulated-paper",
      dualMode: dualPersistence.status()
    },
    dualTemplate,
    dualObject,
    passport: {
      id: state.passport.id,
      agentName: state.passport.agentName,
      mode: state.passport.mode,
      state: state.passport.dualObjectState || state.passport.state,
      allowedPairs: state.passport.allowedPairs
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
      dualPersistence.status().writable ? "DUAL event-bus writes are enabled." : "DUAL is read-linked; event-bus writes require bearer/session/service-account auth."
    ]
  };

  return {
    ...payload,
    proofHash: hashJson(payload)
  };
}

function describeMarketSource(source) {
  if (source === "kraken-cli") return "Kraken CLI";
  if (source === "kraken-public-api") return "Kraken public API";
  return "Simulator";
}

async function addAudit(state, type, status, title, detail, payload = {}) {
  const event = createAuditEvent(type, status, title, detail, payload);
  try {
    const dualResult = await dualPersistence.recordEvent(state.passport, event);
    event.dualSync = dualResult?.skipped
      ? { synced: false, reason: dualResult.reason }
      : { synced: true };
  } catch (error) {
    event.dualSync = { synced: false, error: error.message };
  }
  state.audit.unshift(event);
  return event;
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
