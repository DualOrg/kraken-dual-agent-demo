const base = process.env.DEMO_BASE_URL || "http://localhost:4173";

const health = await get("/api/health");
assert(health.ok, "health endpoint returns ok");
assert(["local", "dual"].includes(health.dual.mode), "DUAL persistence reports a known mode");

const dualStatus = await get("/api/dual/status");
assert(dualStatus.available, "DUAL persistence adapter is available");

const proof = await get("/api/proof");
assert(proof.proofHash, "proof endpoint returns a proof hash");
assert(proof.audit.rootHash, "proof endpoint returns an audit root");

let state = await get("/api/state");
assert(state.passport.mode === "paper", "passport is paper mode");

const market = await get("/api/market?pair=BTCUSD");
assert(market.pair === "BTCUSD", "market endpoint returns BTCUSD");
assert(Number(market.price) > 0, "market endpoint returns a price");

const proposed = await post("/api/propose", { pair: "BTCUSD", side: "buy", notional: 75 });
assert(proposed.proposal.policy.decision === "allow", "small BTC proposal is allowed");

const executed = await post("/api/execute-paper", { id: proposed.proposal.id });
assert(executed.proposal.state === "executed", "allowed paper proposal executes");

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
  if (!response.ok && response.status !== 409) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
