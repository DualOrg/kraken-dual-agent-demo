const state = {
  data: null,
  activeProposalId: null,
  health: null,
  proof: null,
  proofVerification: null,
  dualAuth: null,
  replayExecution: null
};

const pairs = ["BTCUSD", "ETHUSD", "SOLUSD"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const els = {
  adapterStatus: document.querySelector("#adapterStatus"),
  dualStatus: document.querySelector("#dualStatus"),
  marketStrip: document.querySelector("#marketStrip"),
  mandateList: document.querySelector("#mandateList"),
  passportState: document.querySelector("#passportState"),
  stateChip: document.querySelector("#stateChip"),
  timeline: document.querySelector("#timeline"),
  eventCount: document.querySelector("#eventCount"),
  proposalCard: document.querySelector("#proposalCard"),
  approveButton: document.querySelector("#approveButton"),
  executeButton: document.querySelector("#executeButton"),
  dualAuthEmail: document.querySelector("#dualAuthEmail"),
  dualAuthCode: document.querySelector("#dualAuthCode"),
  dualAuthMessage: document.querySelector("#dualAuthMessage"),
  requestCodeButton: document.querySelector("#requestCodeButton"),
  verifyCodeButton: document.querySelector("#verifyCodeButton"),
  executeReplayButton: document.querySelector("#executeReplayButton"),
  exportProofButton: document.querySelector("#exportProofButton"),
  proofGrid: document.querySelector("#proofGrid"),
  tradeForm: document.querySelector("#tradeForm"),
  resetButton: document.querySelector("#resetButton")
};

init();

async function init() {
  bindEvents();
  await checkHealth();
  await loadDualAuthStatus();
  await loadState();
  await refreshMarkets();
  await loadProof();
}

function bindEvents() {
  els.tradeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(els.tradeForm);
    const payload = Object.fromEntries(form.entries());
    payload.notional = Number(payload.notional);
    const result = await postJson("/api/propose", payload);
    state.data = result.state;
    state.activeProposalId = result.proposal.id;
    render();
  });

  els.approveButton.addEventListener("click", async () => {
    if (!state.activeProposalId) return;
    const result = await postJson("/api/approve", { id: state.activeProposalId });
    state.data = result.state;
    render();
  });

  els.executeButton.addEventListener("click", async () => {
    if (!state.activeProposalId) return;
    const response = await fetch("/api/execute-paper", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.activeProposalId })
    });
    const result = await response.json();
    state.data = result.state;
    render();
  });

  els.resetButton.addEventListener("click", async () => {
    state.data = await postJson("/api/reset", {});
    state.activeProposalId = null;
    render();
    await refreshMarkets();
  });

  els.exportProofButton.addEventListener("click", async () => {
    const proof = await loadProof();
    const blob = new Blob([JSON.stringify(proof, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dual-kraken-proof-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  els.requestCodeButton.addEventListener("click", async () => {
    try {
      const email = els.dualAuthEmail.value;
      els.dualAuthMessage.textContent = "Requesting DUAL email code...";
      const result = await postJson("/api/dual/auth/request-code", { email });
      els.dualAuthMessage.textContent = `Code sent to ${result.email}.`;
      await loadDualAuthStatus();
    } catch (error) {
      els.dualAuthMessage.textContent = error.message;
    }
  });

  els.verifyCodeButton.addEventListener("click", async () => {
    try {
      const email = els.dualAuthEmail.value;
      const code = els.dualAuthCode.value;
      els.dualAuthMessage.textContent = "Authenticating bearer session...";
      const result = await postJson("/api/dual/auth/verify-code", { email, code });
      els.dualAuthMessage.textContent = result.detail;
      await checkHealth();
      await loadDualAuthStatus();
      await loadProof();
    } catch (error) {
      els.dualAuthMessage.textContent = error.message;
    }
  });

  els.executeReplayButton.addEventListener("click", async () => {
    try {
      els.dualAuthMessage.textContent = "Executing replay queue into DUAL...";
      const result = await postJson("/api/dual/replay-queue/execute", {});
      state.replayExecution = result.executed ? result.result : result;
      if (result.state) state.data = result.state;
      els.dualAuthMessage.textContent = result.executed
        ? `Executed ${result.result.executedCount} DUAL event-bus writes.`
        : result.readiness?.detail || "DUAL write auth is not ready.";
      render();
      await loadProof();
    } catch (error) {
      els.dualAuthMessage.textContent = error.message;
    }
  });

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await postJson("/api/red-team", { scenario: button.dataset.scenario });
      state.data = result.state;
      render();
    });
  });
}

async function checkHealth() {
  const health = await getJson("/api/health");
  state.health = health;
  const adapterLive = health.adapter.source === "kraken-cli" || health.adapter.source === "kraken-public-api";
  els.adapterStatus.textContent = health.adapter.source === "kraken-cli"
    ? "Kraken CLI live"
    : health.adapter.source === "kraken-public-api"
      ? "Kraken public API live"
      : "Simulator fallback";
  els.adapterStatus.classList.toggle("live", adapterLive);
  els.adapterStatus.classList.toggle("sim", !adapterLive);
  els.dualStatus.textContent = health.dual.available
    ? health.dual.writable ? "DUAL write-sync live" : "DUAL read-linked"
    : "DUAL not configured";
  els.dualStatus.classList.toggle("live", health.dual.available);
  els.dualStatus.classList.toggle("sim", !health.dual.available || !health.dual.writable);
}

async function loadDualAuthStatus() {
  state.dualAuth = await getJson("/api/dual/auth/status");
  renderProof();
}

async function loadState() {
  state.data = await getJson("/api/state");
  render();
}

async function refreshMarkets() {
  for (const pair of pairs) {
    const market = await getJson(`/api/market?pair=${pair}`);
    state.data.market[pair] = market;
    renderMarkets();
  }
  await loadState();
}

function render() {
  if (!state.data) return;
  renderMarkets();
  renderPassport();
  renderProposal();
  renderProof();
  renderTimeline();
}

function renderMarkets() {
  if (!state.data) return;
  els.marketStrip.innerHTML = pairs.map((pair) => {
    const market = state.data.market[pair] || {};
    const change = Number(market.changePct || 0);
    return `
      <article class="quote-card">
        <div class="quote-top">
          <span>${pair}</span>
          <small>${change >= 0 ? "+" : ""}${change.toFixed(2)}%</small>
        </div>
        <strong>${money.format(Number(market.price || 0))}</strong>
        <small>Vol ${Number(market.volume || 0).toLocaleString()} · ${market.source || "seed"}</small>
        <div class="sparkline" aria-hidden="true"></div>
      </article>
    `;
  }).join("");
}

function renderPassport() {
  const passport = state.data.passport;
  els.passportState.textContent = `${passport.agentName} · ${passport.mode.toUpperCase()} mode`;
  els.stateChip.textContent = passport.dualObjectState;
  const rows = [
    ["Allowed pairs", passport.allowedPairs.join(", ")],
    ["Max trade", money.format(passport.maxNotionalUsd)],
    ["Daily cap", `${money.format(passport.dailyNotionalUsed)} / ${money.format(passport.maxDailyNotionalUsd)}`],
    ["Leverage", passport.leverageAllowed ? "Allowed" : "Blocked"],
    ["Approval threshold", money.format(passport.humanApprovalRequiredAbove)],
    ["Policy", passport.approvalPolicy.replaceAll("_", " ")]
  ];

  els.mandateList.innerHTML = rows.map(([label, value]) => `
    <div class="mandate-row">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

function renderProposal() {
  const proposal = state.data.proposals.find((item) => item.id === state.activeProposalId) || state.data.proposals[0];
  if (!proposal) {
    els.proposalCard.className = "proposal-card";
    els.proposalCard.innerHTML = "<span>No active proposal</span><strong>Create a trade intent to see DUAL policy output.</strong>";
    els.approveButton.disabled = true;
    els.executeButton.disabled = true;
    return;
  }

  state.activeProposalId = proposal.id;
  const policy = proposal.policy;
  const statusClass = policy.decision === "block" ? "blocked" : policy.decision === "needs_approval" ? "pending" : "allowed";
  const message = policy.violations[0] || policy.warnings[0] || "Ready for paper execution.";
  els.proposalCard.className = `proposal-card ${statusClass}`;
  els.proposalCard.innerHTML = `
    <span>${proposal.state.replaceAll("_", " ")} · ${proposal.trade.side.toUpperCase()} ${proposal.trade.pair}</span>
    <strong>${money.format(policy.notional)} notional</strong>
    <p>${message}</p>
  `;
  els.approveButton.disabled = proposal.state !== "awaiting_approval";
  els.executeButton.disabled = proposal.state !== "approved";
}

function renderTimeline() {
  const audit = state.data.audit || [];
  els.eventCount.textContent = `${audit.length} events`;
  els.timeline.innerHTML = audit.slice(0, 24).map((event) => `
    <li>
      <div>
        <strong>${event.title}</strong>
        <small>${event.detail}</small>
        <small>${new Date(event.timestamp).toLocaleTimeString()} · ${event.provenanceHash ? event.provenanceHash.slice(0, 12) : event.id}</small>
      </div>
      <span class="event-status ${event.status}">${event.status}</span>
    </li>
  `).join("");
}

async function loadProof() {
  const [proof, proofVerification] = await Promise.all([
    getJson("/api/proof"),
    getJson("/api/proof/verify")
  ]);
  state.proof = proof;
  state.proofVerification = proofVerification;
  renderProof();
  return state.proof;
}

function renderProof() {
  const proof = state.proof;
  const verifier = state.proofVerification;
  const auth = state.dualAuth;
  const dual = proof?.status?.dualMode || state.health?.dual;
  const adapter = proof?.status?.krakenMarketData || state.health?.adapter?.source || "checking";
  const dualObject = proof?.dualObject;
  const dualTemplate = proof?.dualTemplate;
  const replayQueue = proof?.replayQueue;
  const rows = [
    ["Kraken market", sourceLabel(adapter)],
    ["Paper execution", proof?.status?.krakenPaperExecution || "simulated-paper"],
    ["DUAL mode", dual?.available ? dual.writable ? "write-sync" : "read-linked" : "not configured"],
    ["Write readiness", proof?.status?.writeReadiness?.ready ? "ready" : "needs bearer auth"],
    ["Bearer auth", auth?.authenticated ? `session ${auth.email}` : auth?.pendingEmail ? `code sent ${auth.pendingEmail}` : "email code needed"],
    ["Mandate source", dualTemplate?.available ? "DUAL template" : "local seed"],
    ["DUAL object", dualObject?.available ? shortId(dualObject.id) : shortId(dual?.objectId || "pending")],
    ["Replay queue", replayQueue?.eventCount != null ? `${replayQueue.eventCount} events` : "pending"],
    ["Replay execution", state.replayExecution?.executedCount != null ? `${state.replayExecution.executedCount} writes` : "not executed"],
    ["Replay root", replayQueue?.rootHash ? shortId(replayQueue.rootHash) : "pending"],
    ["Audit root", proof?.audit?.rootHash ? shortId(proof.audit.rootHash) : "pending"],
    ["Proof hash", proof?.proofHash ? shortId(proof.proofHash) : "pending"],
    ["Verifier", verifier ? verifier.ok ? "all checks pass" : "checks pending" : "pending"]
  ];

  els.proofGrid.innerHTML = rows.map(([label, value]) => `
    <div class="proof-row">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");

  els.executeReplayButton.disabled = !auth?.writable || !replayQueue?.eventCount;
  if (auth?.authenticated) {
    els.dualAuthMessage.textContent = auth.detail;
  } else if (!els.dualAuthMessage.textContent) {
    els.dualAuthMessage.textContent = auth?.detail || "Email-code auth unlocks DUAL event-bus writes for this server session.";
  }
}

function sourceLabel(source) {
  if (source === "kraken-cli") return "Kraken CLI";
  if (source === "kraken-public-api") return "Kraken public API";
  return source || "simulator";
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 16) return text || "pending";
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok && response.status !== 409) {
    throw new Error(body.message || body.error || `POST ${url} failed`);
  }
  return body;
}
