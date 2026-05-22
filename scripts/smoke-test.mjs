const base = process.env.DEMO_BASE_URL || "http://localhost:4173";

const health = await get("/api/health");
assert(health.ok, "health endpoint returns ok");
assert(["local", "dual"].includes(health.dual.mode), "DUAL persistence reports a known mode");
assert(health.app.mcp === "/mcp", "health advertises MCP endpoint");
assert(health.features.emailCodeRequired === false, "email-code auth is not required for demo writes");
assert(Array.isArray(health.dual.links), "health exposes DUAL data links");

const openapi = await get("/api/openapi.json");
assert(openapi.openapi === "3.1.0", "OpenAPI endpoint returns a 3.1 document");
assert(openapi.paths["/mcp"], "OpenAPI document advertises MCP endpoint");
assert(openapi["x-mcp"].tools.includes("kraken_dual_propose_and_execute_paper_trade"), "OpenAPI document lists MCP trading tool");

const mcpInit = await mcp("initialize", {});
assert(mcpInit.protocolVersion === "2025-06-18", "MCP initialize returns current protocol version");
assert(mcpInit.serverInfo.name === "kraken-dual-agent-demo", "MCP initialize returns server name");

const mcpTools = await mcp("tools/list", {});
const mcpToolNames = mcpTools.tools.map((tool) => tool.name);
assert(mcpToolNames.includes("kraken_dual_get_market"), "MCP tools include market lookup");
assert(mcpToolNames.includes("kraken_dual_propose_and_execute_paper_trade"), "MCP tools include paper trade execution");
assert(mcpToolNames.includes("kraken_dual_get_trade_receipts"), "MCP tools include trade receipt readback");

const dualStatus = await get("/api/dual/status");
assert(dualStatus.available, "DUAL persistence adapter is available");
assert(Array.isArray(dualStatus.links), "DUAL status exposes Console/Explorer links");

const writeReadiness = await get("/api/dual/write-readiness");
assert(typeof writeReadiness.ready === "boolean", "write readiness reports a boolean ready state");
assert(writeReadiness.requiredAuthMode === "api_key", "event-bus writes require API-key auth");
assert(!JSON.stringify(writeReadiness).includes("bearer/session"), "write readiness does not require bearer/session auth");

const dualAuthStatus = await get("/api/dual/auth/status");
assert(typeof dualAuthStatus.authenticated === "boolean", "DUAL auth status reports session state");
assert(dualAuthStatus.emailCodeRequired === false, "DUAL email-code auth is optional");
assert(typeof dualAuthStatus.writeGate?.allowed === "boolean", "DUAL auth status exposes operator write gate");

await post("/api/reset", {});

const replayQueue = await get("/api/dual/replay-queue");
assert(replayQueue.rootHash, "replay queue returns a root hash");
assert(Array.isArray(replayQueue.events), "replay queue returns event payloads");
assert(typeof replayQueue.pendingCount === "number", "replay queue reports pending event count");
assert(typeof replayQueue.syncedCount === "number", "replay queue reports synced event count");

const initialTradeReceipts = await get("/api/dual/trade-receipts");
assert(initialTradeReceipts.rootHash, "trade receipt queue returns a root hash");
assert(initialTradeReceipts.receiptCount === 0, "reset state starts with no trade receipts");

const replayExecution = await post("/api/dual/replay-queue/execute", {});
assert(typeof replayExecution.executed === "boolean", "replay execution reports whether writes ran");

const proof = await get("/api/proof");
assert(proof.proofHash, "proof endpoint returns a proof hash");
assert(proof.audit.rootHash, "proof endpoint returns an audit root");
assert(typeof proof.status.writeReadiness.ready === "boolean", "proof includes write readiness");
assert(proof.replayQueue.rootHash, "proof includes replay queue root");
assert(typeof proof.replayQueue.pendingCount === "number", "proof includes pending replay count");
assert(proof.tradeReceipts.rootHash, "proof includes trade receipt root");
assert(typeof proof.tradeReceipts.pendingCount === "number", "proof includes pending trade receipt count");
assert(proof.policy.hash, "proof includes policy hash");
assert(proof.dualBatch && typeof proof.dualBatch.available === "boolean", "proof includes DUAL batch status");
assert(Array.isArray(proof.verification), "proof includes verification checks");
assert(Array.isArray(proof.links), "proof includes DUAL data links");
const passportTemplateLink = proof.links.find((link) => link.id === "dual-record-template");
const passportObjectLink = proof.links.find((link) => link.id === "dual-record-object");
const hasDualRecordIds = Boolean(
  proof.status.dualMode?.templateId
  || proof.status.dualMode?.objectId
  || proof.dualBatch?.id
  || proof.dualBatch?.affectedActions?.length
);
if (hasDualRecordIds) {
  assert(proof.links.some((link) => link.source === "dual-record"), "proof includes explicit DUAL record links");
}
if (proof.status.dualMode?.templateId) {
  assert(passportTemplateLink?.href?.includes(proof.status.dualMode.templateId), "proof template link targets the explicit DUAL template id");
  const templateRecord = await get(passportTemplateLink.href);
  assert(templateRecord.id === proof.status.dualMode.templateId, "template record link resolves without relying on Console routes");
}
if (proof.status.dualMode?.objectId) {
  assert(passportObjectLink?.href?.includes(proof.status.dualMode.objectId), "proof object link targets the explicit DUAL object id");
  const objectRecord = await get(passportObjectLink.href);
  assert(objectRecord.id === proof.status.dualMode.objectId, "object record link resolves without relying on Console routes");
}
const batchRecordLink = proof.links.find((link) => link.id === "dual-record-batch");
if (proof.dualBatch?.id) {
  assert(batchRecordLink?.href?.includes(proof.dualBatch.id), "proof batch link targets the explicit DUAL batch id");
}

const proofVerify = await get("/api/proof/verify");
assert(typeof proofVerify.ok === "boolean", "proof verifier returns an ok flag");
assert(proofVerify.proofHash === proof.proofHash, "proof verifier checks the same proof hash");
assert(["complete", "valid_with_pending_replay", "failed"].includes(proofVerify.status), "proof verifier reports a proof status");
assert(typeof proofVerify.complete === "boolean", "proof verifier reports completeness separately");
assert(Array.isArray(proofVerify.checks), "proof verifier returns checks");

const proofAgain = await get("/api/proof");
assert(proofAgain.proofHash === proof.proofHash, "proof hash is stable across generatedAt changes");

let state = await get("/api/state");
assert(state.passport.mode === "paper", "passport is paper mode");

const policy = await post("/api/policy", {
  allowedPairs: ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"],
  maxNotionalUsd: 250,
  maxDailyNotionalUsd: 1000,
  humanApprovalRequiredAbove: 100,
  leverageAllowed: false
});
assert(policy.policy.maxNotionalUsd === 250, "policy endpoint updates max trade");
assert(policy.policy.allowedPairs.includes("BTCUSD"), "policy endpoint keeps BTCUSD allowed");
assert(policy.policy.allowedPairs.includes("DUALUSD"), "policy endpoint keeps DUALUSD allowed");

const market = await get("/api/market?pair=BTCUSD");
assert(market.pair === "BTCUSD", "market endpoint returns BTCUSD");
assert(Number(market.price) > 0, "market endpoint returns a price");

const dualMarket = await get("/api/market?pair=DUALUSD");
assert(dualMarket.pair === "DUALUSD", "market endpoint returns DUALUSD");
assert(Number(dualMarket.price) > 0, "DUALUSD market endpoint returns a price");

const proposed = await post("/api/propose", { pair: "BTCUSD", side: "buy", notional: 75 });
assert(proposed.proposal.policy.decision === "allow", "small BTC proposal is allowed");

const executed = await post("/api/execute-paper", { id: proposed.proposal.id });
assert(executed.proposal.state === "executed", "allowed paper proposal executes");
assert(executed.tradeReceipt?.id?.startsWith("tr-"), "paper execution creates a deterministic trade receipt");

const dualProposal = await post("/api/propose", { pair: "DUALUSD", side: "buy", notional: 10 });
assert(dualProposal.proposal.policy.decision === "allow", "small DUAL proposal is allowed");

const dualExecuted = await post("/api/execute-paper", { id: dualProposal.proposal.id });
assert(dualExecuted.proposal.state === "executed", "allowed DUAL paper proposal executes");
assert(dualExecuted.tradeReceipt?.pair === "DUALUSD", "DUAL paper execution creates a DUALUSD trade receipt");

const tradeReceipts = await get("/api/dual/trade-receipts");
assert(tradeReceipts.receiptCount >= 2, "trade receipt queue includes executed paper trades");
assert(tradeReceipts.pendingCount >= 0, "trade receipt queue reports pending mints");
assert(tradeReceipts.latest[0]?.id?.startsWith("tr-"), "trade receipt queue exposes latest receipt summaries");

const redTeam = await post("/api/red-team", { scenario: "leverage" });
assert(redTeam.policy.decision === "block", "leverage red-team scenario is blocked");

const mcpMarket = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_get_market",
  arguments: { pair: "DUALUSD" }
}));
assert(mcpMarket.market.pair === "DUALUSD", "MCP market tool returns DUALUSD");
assert(Number(mcpMarket.market.price) > 0, "MCP market tool returns a DUALUSD price");

const mcpTrade = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_propose_and_execute_paper_trade",
  arguments: { pair: "DUALUSD", side: "buy", notional_usd: 10 }
}));
assert(mcpTrade.status === "executed", "MCP paper trade tool executes allowed DUALUSD trade");
assert(mcpTrade.proposal.trade.pair === "DUALUSD", "MCP trade uses DUALUSD pair");
assert(mcpTrade.result.digest, "MCP paper trade returns execution digest");
assert(mcpTrade.tradeReceipt?.id?.startsWith("tr-"), "MCP paper trade returns a trade receipt");

const mcpTradeReceipts = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_get_trade_receipts",
  arguments: {}
}));
assert(mcpTradeReceipts.tradeReceiptQueue.receiptCount >= 3, "MCP trade receipt tool returns executed receipts");

const mcpVerify = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_verify_proof",
  arguments: {}
}));
assert(typeof mcpVerify.verification.ok === "boolean", "MCP proof verifier returns ok flag");
assert(mcpVerify.verification.proofHash, "MCP proof verifier returns proof hash");

const mcpResources = await mcp("resources/list", {});
assert(mcpResources.resources.some((resource) => resource.uri === "kraken-dual://proof"), "MCP resources include proof");

const mcpBlocked = await mcp("tools/call", {
  name: "kraken_dual_get_market",
  arguments: { pair: "DOGEUSD" }
});
assert(mcpBlocked.isError, "MCP tool errors are returned as tool-level isError content");

console.log("Smoke test passed");

async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function post(path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok && ![403, 409].includes(response.status)) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function mcp(method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
  });
  if (!response.ok) throw new Error(`/mcp ${method} returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`/mcp ${method} error: ${payload.error.message}`);
  return payload.result;
}

function mcpJson(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP result did not include text JSON content");
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
