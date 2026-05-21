const base = process.env.DEMO_BASE_URL || "http://localhost:4173";

const health = await get("/api/health");
assert(health.ok, "health endpoint returns ok");
assert(["local", "dual"].includes(health.dual.mode), "DUAL persistence reports a known mode");

const dualStatus = await get("/api/dual/status");
assert(dualStatus.available, "DUAL persistence adapter is available");

const writeReadiness = await get("/api/dual/write-readiness");
assert(typeof writeReadiness.ready === "boolean", "write readiness reports a boolean ready state");

const dualAuthStatus = await get("/api/dual/auth/status");
assert(typeof dualAuthStatus.authenticated === "boolean", "DUAL auth status reports session state");

await post("/api/reset", {});

const replayQueue = await get("/api/dual/replay-queue");
assert(replayQueue.rootHash, "replay queue returns a root hash");
assert(Array.isArray(replayQueue.events), "replay queue returns event payloads");
assert(typeof replayQueue.pendingCount === "number", "replay queue reports pending event count");
assert(typeof replayQueue.syncedCount === "number", "replay queue reports synced event count");

const replayExecution = await post("/api/dual/replay-queue/execute", {});
assert(typeof replayExecution.executed === "boolean", "replay execution reports whether writes ran");

const proof = await get("/api/proof");
assert(proof.proofHash, "proof endpoint returns a proof hash");
assert(proof.audit.rootHash, "proof endpoint returns an audit root");
assert(typeof proof.status.writeReadiness.ready === "boolean", "proof includes write readiness");
assert(proof.replayQueue.rootHash, "proof includes replay queue root");
assert(typeof proof.replayQueue.pendingCount === "number", "proof includes pending replay count");
assert(proof.policy.hash, "proof includes policy hash");
assert(proof.dualBatch && typeof proof.dualBatch.available === "boolean", "proof includes DUAL batch status");
assert(Array.isArray(proof.verification), "proof includes verification checks");

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

const dualProposal = await post("/api/propose", { pair: "DUALUSD", side: "buy", notional: 10 });
assert(dualProposal.proposal.policy.decision === "allow", "small DUAL proposal is allowed");

const dualExecuted = await post("/api/execute-paper", { id: dualProposal.proposal.id });
assert(dualExecuted.proposal.state === "executed", "allowed DUAL paper proposal executes");

const redTeam = await post("/api/red-team", { scenario: "leverage" });
assert(redTeam.policy.decision === "block", "leverage red-team scenario is blocked");

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
