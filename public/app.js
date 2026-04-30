const state = {
  data: null,
  activeProposalId: null
};

const pairs = ["BTCUSD", "ETHUSD", "SOLUSD"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const els = {
  adapterStatus: document.querySelector("#adapterStatus"),
  marketStrip: document.querySelector("#marketStrip"),
  mandateList: document.querySelector("#mandateList"),
  passportState: document.querySelector("#passportState"),
  stateChip: document.querySelector("#stateChip"),
  timeline: document.querySelector("#timeline"),
  eventCount: document.querySelector("#eventCount"),
  proposalCard: document.querySelector("#proposalCard"),
  approveButton: document.querySelector("#approveButton"),
  executeButton: document.querySelector("#executeButton"),
  tradeForm: document.querySelector("#tradeForm"),
  resetButton: document.querySelector("#resetButton")
};

init();

async function init() {
  bindEvents();
  await checkHealth();
  await loadState();
  await refreshMarkets();
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
  els.adapterStatus.textContent = health.adapter.krakenCliAvailable ? "Kraken CLI live" : "Simulator fallback";
  els.adapterStatus.classList.toggle("live", health.adapter.krakenCliAvailable);
  els.adapterStatus.classList.toggle("sim", !health.adapter.krakenCliAvailable);
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
  if (!response.ok && response.status !== 409) throw new Error(`POST ${url} failed`);
  return response.json();
}
