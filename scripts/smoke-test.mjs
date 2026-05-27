const base = process.env.DEMO_BASE_URL || "http://localhost:4173";

const health = await get("/api/health");
assert(health.ok, "health endpoint returns ok");
assert(["local", "dual"].includes(health.dual.mode), "DUAL persistence reports a known mode");
assert(health.app.mcp === "/mcp", "health advertises MCP endpoint");
assert(health.features.emailCodeRequired === false, "email-code auth is not required for demo writes");
assert(Array.isArray(health.dual.links), "health exposes DUAL data links");
assert(health.agentMandates?.configured === true, "health exposes configured Agent Mandates gate");
assert(health.agentMandates?.readOnly === true, "Agent Mandates gate is read-only from Kraken");
assert(health.agentMandates?.mode === "required", "Agent Mandates gate is required by default");
assert(["http", "mcp"].includes(health.agentMandates?.transport), "Agent Mandates gate reports its transport");
if (process.env.AGENT_MANDATES_MCP_URL) {
  assert(health.agentMandates.transport === "mcp", "Agent Mandates gate can use MCP transport");
  assert(health.agentMandates.mcpUrl === process.env.AGENT_MANDATES_MCP_URL, "Agent Mandates MCP URL is reflected in health");
}

const openapi = await get("/api/openapi.json");
assert(openapi.openapi === "3.1.0", "OpenAPI endpoint returns a 3.1 document");
assert(openapi.paths["/mcp"], "OpenAPI document advertises MCP endpoint");
assert(openapi["x-mcp"].tools.includes("kraken_dual_propose_and_execute_paper_trade"), "OpenAPI document lists MCP trading tool");

const mcpInit = await mcp("initialize", {});
assert(mcpInit.protocolVersion === "2025-06-18", "MCP initialize returns current protocol version");
assert(mcpInit.serverInfo.name === "kraken-dual-agent-demo", "MCP initialize returns server name");

const mcpTools = await mcp("tools/list", {});
const mcpToolNames = mcpTools.tools.map((tool) => tool.name);
assert(!mcpToolNames.some((name) => name.includes("authenticate")), "MCP tools do not require token authentication");
assert(mcpToolNames.includes("kraken_dual_get_market"), "MCP tools include market lookup");
assert(mcpToolNames.includes("kraken_dual_propose_and_execute_paper_trade"), "MCP tools include paper trade execution");
assert(mcpToolNames.includes("kraken_dual_get_trade_receipts"), "MCP tools include trade receipt readback");
assert(mcpToolNames.includes("kraken_dual_get_transaction_history"), "MCP tools include transaction history readback");
const mcpTradeTool = mcpTools.tools.find((tool) => tool.name === "kraken_dual_propose_and_execute_paper_trade");
assert(mcpTradeTool?.["x-dual"]?.requiresWriteReadinessForAnchoring === true, "MCP trade tool annotates DUAL write-readiness dependency");

const dualStatus = await get("/api/dual/status");
assert(dualStatus.available, "DUAL persistence adapter is available");
assert(Array.isArray(dualStatus.links), "DUAL status exposes Console/Explorer links");

const writeReadiness = await get("/api/dual/write-readiness");
assert(typeof writeReadiness.ready === "boolean", "write readiness reports a boolean ready state");
assert(typeof writeReadiness.canWriteNow === "boolean", "write readiness exposes a flattened canWriteNow state");
assert(writeReadiness.reason, "write readiness exposes a reason");
assert(writeReadiness.requiredAuthMode === "api_key", "event-bus writes require API-key auth");
assert(!JSON.stringify(writeReadiness).includes("bearer/session"), "write readiness does not require bearer/session auth");

const dualAuthStatus = await get("/api/dual/auth/status");
assert(typeof dualAuthStatus.authenticated === "boolean", "DUAL auth status reports session state");
assert(dualAuthStatus.emailCodeRequired === false, "DUAL email-code auth is optional");
assert(typeof dualAuthStatus.writeGate?.allowed === "boolean", "DUAL auth status exposes demo write gate");

await post("/api/reset", {});

const replayQueue = await get("/api/dual/replay-queue");
assert(replayQueue.rootHash, "replay queue returns a root hash");
assert(Array.isArray(replayQueue.events), "replay queue returns event payloads");
assert(typeof replayQueue.pendingCount === "number", "replay queue reports pending event count");
assert(typeof replayQueue.syncedCount === "number", "replay queue reports synced event count");

const initialTradeReceipts = await get("/api/dual/trade-receipts");
assert(initialTradeReceipts.rootHash, "trade receipt queue returns a root hash");
assert(initialTradeReceipts.receiptCount === 0, "reset state starts with no trade receipts");
const initialHistory = await get("/api/transactions/history");
const initialHistoryRecoveredFromDual = Array.isArray(initialHistory.transactions)
  && initialHistory.transactions.length > 0
  && initialHistory.transactions.every((tx) => tx.recoveredFrom);
assert(
  initialHistory.transactionCount === 0 || initialHistoryRecoveredFromDual,
  "reset state starts with empty local transaction history or recovered DUAL proof history"
);

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
assert(proof.status.agentMandates?.readOnly === true, "proof includes read-only Agent Mandates gate status");
assert(proof.dualBatch && typeof proof.dualBatch.available === "boolean", "proof includes DUAL batch status");
assert(proof.settlement?.layers?.length === 3, "proof includes L3/L2/L1 settlement route");
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
  assert(proof.links.some((link) => link.source === "dual-record" || targetHref(link, "dual-record")), "proof includes explicit DUAL record links");
}
if (proof.status.dualMode?.templateId) {
  const templateRecordHref = targetHref(passportTemplateLink, "dual-record");
  const templateConsoleHref = targetHref(passportTemplateLink, "console") || passportTemplateLink?.href;
  assert(templateConsoleHref?.includes(proof.status.dualMode.templateId), "proof template link targets the explicit DUAL template id in Console");
  assert(templateRecordHref?.includes(proof.status.dualMode.templateId), "proof template link keeps explicit DUAL data readback");
  const templateRecord = await get(templateRecordHref);
  assert(templateRecord.id === proof.status.dualMode.templateId, "template record link resolves without relying on Console routes");
}
if (proof.status.dualMode?.objectId) {
  const objectRecordHref = targetHref(passportObjectLink, "dual-record");
  const objectConsoleHref = targetHref(passportObjectLink, "console") || passportObjectLink?.href;
  assert(objectConsoleHref?.includes(proof.status.dualMode.objectId), "proof object link targets the explicit DUAL object id in Console");
  assert(objectRecordHref?.includes(proof.status.dualMode.objectId), "proof object link keeps explicit DUAL data readback");
  const objectRecord = await get(objectRecordHref);
  assert(objectRecord.id === proof.status.dualMode.objectId, "object record link resolves without relying on Console routes");
}
const batchRecordLink = proof.links.find((link) => link.id === "dual-record-batch");
if (proof.dualBatch?.id) {
  const batchDataHref = targetHref(batchRecordLink, "dual-record") || batchRecordLink?.href;
  assert(batchDataHref?.includes(proof.dualBatch.id), "proof batch link targets the explicit DUAL batch id");
  if (proof.dualBatch?.l2TransactionHash || proof.dualBatch?.transactionHash) {
    const batchL2Href = targetHref(batchRecordLink, "l2-explorer") || batchRecordLink?.href;
    assert(batchL2Href?.includes("explorer-test-v2.dual.network/tx/"), "proof batch links include L2 explorer transaction targets");
  }
}
const actionWithHash = proof.links.find((link) => link.id?.startsWith("dual-record-action-") && targetHref(link, "l3-explorer"));
if (proof.dualBatch?.affectedActions?.some((action) => action?.hash)) {
  const actionL3Href = targetHref(actionWithHash, "l3-explorer") || actionWithHash?.href;
  assert(actionL3Href?.includes("explorer-testnet.dual.network/actions/"), "proof action links include L3 explorer action targets");
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

await post("/api/policy", {
  allowedPairs: ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"],
  maxNotionalUsd: 1000,
  maxDailyNotionalUsd: 2000,
  humanApprovalRequiredAbove: 2000,
  leverageAllowed: false
});
const mandateBlocked = await post("/api/propose", { pair: "BTCUSD", side: "buy", notional: 300 });
assert(mandateBlocked.proposal.policy.decision === "block", "Agent Mandates blocks trades above the canonical mandate limit");
assert(mandateBlocked.proposal.policy.agentMandate?.code === "spend_limit_exceeded", "Agent Mandates reports the spend-limit reason");
await post("/api/policy", {
  allowedPairs: ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"],
  maxNotionalUsd: 250,
  maxDailyNotionalUsd: 1000,
  humanApprovalRequiredAbove: 100,
  leverageAllowed: false
});

const market = await get("/api/market?pair=BTCUSD");
assert(market.pair === "BTCUSD", "market endpoint returns BTCUSD");
assert(Number(market.price) > 0, "market endpoint returns a price");
assert(Number.isFinite(Number(market.changePct)), "market endpoint returns a numeric change percentage");

const dualMarket = await get("/api/market?pair=DUALUSD");
assert(dualMarket.pair === "DUALUSD", "market endpoint returns DUALUSD");
assert(Number(dualMarket.price) > 0, "DUALUSD market endpoint returns a price");
assert([market.changePct, dualMarket.changePct].some((value) => Number(value) !== 0), "market endpoint does not force all change percentages to 0");

const proposed = await post("/api/propose", { pair: "BTCUSD", side: "buy", notional: 75 });
assert(proposed.proposal.policy.decision === "allow", "small BTC proposal is allowed");
assert(proposed.proposal.policy.agentMandate?.result === "Approved", "small BTC proposal is approved by Agent Mandates");
assert(proposed.proposal.policy.agentMandate?.publicWrites === false, "Agent Mandates evaluation does not write from Kraken");
assert(proposed.proposal.policy.agentMandate?.proof?.objectId, "Agent Mandates evaluation returns DUAL object proof");

const executed = await post("/api/execute-paper", { id: proposed.proposal.id });
assert(executed.proposal.state === "executed", "allowed paper proposal executes");
assert(executed.proposal.policy.agentMandate?.result === "Approved", "paper execution rechecks Agent Mandates before fill");
assert(executed.tradeReceipt?.id?.startsWith("tr-"), "paper execution creates a deterministic trade receipt");
assert(executed.tradeReceipt?.agentMandate?.decisionHash, "paper execution receipt includes Agent Mandates decision hash");

const dualProposal = await post("/api/propose", { pair: "DUALUSD", side: "buy", notional: 10 });
assert(dualProposal.proposal.policy.decision === "allow", "small DUAL proposal is allowed");

const dualExecuted = await post("/api/execute-paper", { id: dualProposal.proposal.id });
assert(dualExecuted.proposal.state === "executed", "allowed DUAL paper proposal executes");
assert(dualExecuted.tradeReceipt?.pair === "DUALUSD", "DUAL paper execution creates a DUALUSD trade receipt");

const tradeReceipts = await get("/api/dual/trade-receipts");
assert(tradeReceipts.receiptCount >= 2, "trade receipt queue includes executed paper trades");
assert(tradeReceipts.pendingCount >= 0, "trade receipt queue reports pending mints");
assert(tradeReceipts.latest[0]?.id?.startsWith("tr-"), "trade receipt queue exposes latest receipt summaries");

const transactionHistory = await get("/api/transactions/history?limit=5");
assert(transactionHistory.transactionCount >= 2, "transaction history includes executed paper trades");
assert(transactionHistory.summary?.status, "transaction history includes a proof summary");
assert(typeof transactionHistory.summary?.l3ActionCount === "number", "transaction history summarizes L3 actions");
assert(transactionHistory.transactions[0]?.proposalId?.startsWith("prop-"), "transaction history includes proposal ids");
assert(transactionHistory.transactions[0]?.eventId?.startsWith("evt-"), "transaction history exposes audit event ids for UI trace links");
assert(Number(transactionHistory.transactions[0]?.trade?.priceUsd || transactionHistory.transactions[0]?.priceUsd) > 0, "transaction history includes trade price");
assert(Number(transactionHistory.transactions[0]?.trade?.quantity || transactionHistory.transactions[0]?.quantity) > 0, "transaction history includes trade quantity");
assert(transactionHistory.transactions[0]?.route?.some((step) => step.layer === "l3"), "transaction history exposes the L3 route");
assert(transactionHistory.transactions[0]?.links?.some((link) => ["Receipt", "Data"].includes(link.label)), "transaction history exposes receipt/data links");
const misleadingBatchLinks = transactionHistory.transactions
  .flatMap((tx) => tx.links || [])
  .filter((link) => /L2\/L1 batch|L2 batch/i.test(link.label) && link.source === "dual-record");
assert(misleadingBatchLinks.length === 0, "transaction history does not label internal batch data as an L2/L1 explorer link");
if (transactionHistory.summary?.latestL2TransactionHash) {
  const explorerBatchLinks = transactionHistory.transactions
    .flatMap((tx) => tx.links || [])
    .filter((link) => link.label === "L2 explorer");
  const rollupLinks = transactionHistory.transactions
    .flatMap((tx) => tx.links || [])
    .filter((link) => link.label === "L1 roll-up");
  assert(explorerBatchLinks.some((link) => link.source === "l2-explorer" && link.href?.includes("explorer-test-v2.dual.network/tx/")), "transaction history exposes L2 batch proof as an L2 explorer link when an L2 tx hash exists");
  assert(rollupLinks.some((link) => ["l1-rollup", "l2-explorer"].includes(link.source) && link.href?.includes("explorer-test")), "transaction history keeps a visible L1 roll-up route when explorer evidence exists");
}

const redTeam = await post("/api/red-team", { scenario: "leverage" });
assert(redTeam.policy.decision === "block", "leverage red-team scenario is blocked");
assert(redTeam.policy.agentMandate?.code === "local_policy_blocked", "local policy blocks red-team before external mandate call");
const historyWithBlock = await get("/api/transactions/history?limit=5");
assert(historyWithBlock.policyBlockCount >= 1, "transaction history exposes blocked policy proofs");
assert(historyWithBlock.policyBlocks[0]?.title?.includes("tested"), "blocked policy proof includes a visible event title");
assert(historyWithBlock.policyBlocks[0]?.dual, "blocked policy proof includes DUAL sync state");

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
assert(mcpTrade.proposal.policy.agentMandate?.result === "Approved", "MCP trade is approved by Agent Mandates gate");
assert(mcpTrade.result.digest, "MCP paper trade returns execution digest");
assert(mcpTrade.result.executionPath, "MCP paper trade returns execution path");
assert(!Object.hasOwn(mcpTrade.result, "fallbackReason"), "MCP paper trade does not expose simulator path as fallback error");
assert(mcpTrade.tradeReceipt?.id?.startsWith("tr-"), "MCP paper trade returns a trade receipt");
assert(Array.isArray(mcpTrade.warnings), "MCP trade returns top-level warnings");
const mcpTradeAnchored = Boolean(mcpTrade.tradeReceipt?.dualSync?.synced);
const mcpTradeWarnedAnchoringUnavailable = mcpTrade.warnings.some((warning) => warning.code === "dual_anchoring_not_available");
assert(mcpTradeAnchored || mcpTradeWarnedAnchoringUnavailable, "MCP trade either anchors to DUAL or warns when DUAL anchoring is not available");
if (mcpTrade.writeState?.canWriteNow) {
  assert(mcpTradeAnchored, "MCP trade mints a DUAL receipt when write readiness is active");
}

const mcpCompactStatus = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_get_status",
  arguments: { compact: true, include_proof: false }
}));
assert(mcpCompactStatus.compact === true, "MCP compact status returns compact flag");
assert(typeof mcpCompactStatus.canWriteNow === "boolean", "MCP compact status flattens write state");
assert(Array.isArray(mcpCompactStatus.warnings), "MCP compact status includes warnings");

const mcpTradeReceipts = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_get_trade_receipts",
  arguments: {}
}));
assert(mcpTradeReceipts.tradeReceiptQueue.receiptCount >= 3, "MCP trade receipt tool returns executed receipts");

const mcpTransactionHistory = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_get_transaction_history",
  arguments: { limit: 5 }
}));
assert(mcpTransactionHistory.transactionHistory.transactionCount >= 3, "MCP transaction history returns executed trades");
assert(mcpTransactionHistory.transactionHistory.summary?.status, "MCP transaction history returns the proof summary");
assert(Number(mcpTransactionHistory.transactionHistory.transactions[0]?.trade?.notionalUsd || mcpTransactionHistory.transactionHistory.transactions[0]?.notionalUsd) > 0, "MCP transaction history includes trade economics");
assert(mcpTransactionHistory.transactionHistory.transactions[0]?.links?.length >= 1, "MCP transaction history includes proof links");

const mcpVerify = mcpJson(await mcp("tools/call", {
  name: "kraken_dual_verify_proof",
  arguments: {}
}));
assert(typeof mcpVerify.verification.ok === "boolean", "MCP proof verifier returns ok flag");
assert(mcpVerify.verification.proofHash, "MCP proof verifier returns proof hash");

const mcpResources = await mcp("resources/list", {});
assert(mcpResources.resources.some((resource) => resource.uri === "kraken-dual://proof"), "MCP resources include proof");
assert(mcpResources.resources.some((resource) => resource.uri === "kraken-dual://transaction-history"), "MCP resources include transaction history");

const mcpBlocked = await mcp("tools/call", {
  name: "kraken_dual_get_market",
  arguments: { pair: "DOGEUSD" }
});
assert(mcpBlocked.isError, "MCP tool errors are returned as tool-level isError content");

console.log("Smoke test passed");

function targetHref(link, source) {
  return link?.targets?.find((target) => target.source === source)?.href || null;
}

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
