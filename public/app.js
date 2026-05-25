const state = {
  data: null,
  activeProposalId: null,
  health: null,
  proof: null,
  proofVerification: null,
  dualAuth: null,
  replayExecution: null,
  actionPassportSetup: null,
  tradeReceiptTemplateSetup: null,
  tradeReceiptReplay: null
};

const pairs = ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const els = {
  adapterStatus: document.querySelector("#adapterStatus"),
  dualStatus: document.querySelector("#dualStatus"),
  marketStrip: document.querySelector("#marketStrip"),
  marketStats: document.querySelector("#marketStats"),
  orderBook: document.querySelector("#orderBook"),
  depthMeter: document.querySelector("#depthMeter"),
  bookPair: document.querySelector("#bookPair"),
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
  dualEmailAuthPanel: document.querySelector("#dualEmailAuthPanel"),
  dualLinks: document.querySelector("#dualLinks"),
  settlementRail: document.querySelector("#settlementRail"),
  requestCodeButton: document.querySelector("#requestCodeButton"),
  verifyCodeButton: document.querySelector("#verifyCodeButton"),
  setupActionPassportButton: document.querySelector("#setupActionPassportButton"),
  setupReceiptTemplateButton: document.querySelector("#setupReceiptTemplateButton"),
  executeReplayButton: document.querySelector("#executeReplayButton"),
  executeReceiptReplayButton: document.querySelector("#executeReceiptReplayButton"),
  exportProofButton: document.querySelector("#exportProofButton"),
  proofGrid: document.querySelector("#proofGrid"),
  bindingChain: document.querySelector("#bindingChain"),
  bindingSummary: document.querySelector("#bindingSummary"),
  policyForm: document.querySelector("#policyForm"),
  policyMessage: document.querySelector("#policyMessage"),
  policyMaxTrade: document.querySelector("#policyMaxTrade"),
  policyDailyCap: document.querySelector("#policyDailyCap"),
  policyApprovalThreshold: document.querySelector("#policyApprovalThreshold"),
  policyLeverageAllowed: document.querySelector("#policyLeverageAllowed"),
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
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = {
        command: ".trade-panel",
        mandate: ".passport-panel",
        proof: ".proof-panel",
        audit: ".audit-panel",
        redteam: ".red-panel"
      }[button.dataset.view];
      document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

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
    const result = await postJson("/api/execute-paper", { id: state.activeProposalId });
    state.data = result.state;
    await loadProof();
    render();
  });

  els.resetButton.addEventListener("click", async () => {
    state.data = await postJson("/api/reset", {});
    state.activeProposalId = null;
    render();
    await refreshMarkets();
    await loadProof();
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
      els.dualAuthMessage.textContent = "Authenticating DUAL browser session...";
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

  els.setupActionPassportButton.addEventListener("click", async () => {
    try {
      els.dualAuthMessage.textContent = "Creating action-enabled DUAL passport...";
      const result = await postJson("/api/dual/action-passport/setup", {
        confirm: "create-action-enabled-kraken-passport"
      });
      state.actionPassportSetup = result;
      els.dualAuthMessage.textContent = `Action passport ready: ${shortId(result.vercelEnv?.DUAL_AGENT_PASSPORT_TEMPLATE_ID || result.template?.id)}`;
      await checkHealth();
      await loadProof();
    } catch (error) {
      els.dualAuthMessage.textContent = error.message;
    }
  });

  els.setupReceiptTemplateButton.addEventListener("click", async () => {
    try {
      els.dualAuthMessage.textContent = "Creating DUAL trade receipt template...";
      const result = await postJson("/api/dual/trade-receipt-template/setup", {
        confirm: "create-dual-trade-receipt-template"
      });
      state.tradeReceiptTemplateSetup = result;
      els.dualAuthMessage.textContent = `Receipt template ready: ${shortId(result.vercelEnv?.DUAL_TRADE_RECEIPT_TEMPLATE_ID || result.template?.id)}`;
      await checkHealth();
      await loadProof();
    } catch (error) {
      els.dualAuthMessage.textContent = error.message;
    }
  });

  els.executeReceiptReplayButton.addEventListener("click", async () => {
    try {
      els.dualAuthMessage.textContent = "Minting pending trade receipts into DUAL...";
      const result = await postJson("/api/dual/trade-receipts/replay", {});
      state.tradeReceiptReplay = result.executed ? result.result : result;
      if (result.state) state.data = result.state;
      els.dualAuthMessage.textContent = result.executed
        ? `Minted ${result.result.executedCount} DUAL trade receipts.`
        : result.detail || "DUAL trade receipt minting is not ready.";
      render();
      await loadProof();
    } catch (error) {
      els.dualAuthMessage.textContent = error.message;
    }
  });

  els.policyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      els.policyMessage.textContent = "Saving...";
      const form = new FormData(els.policyForm);
      const payload = {
        allowedPairs: form.getAll("allowedPairs"),
        maxNotionalUsd: Number(form.get("maxNotionalUsd")),
        maxDailyNotionalUsd: Number(form.get("maxDailyNotionalUsd")),
        humanApprovalRequiredAbove: Number(form.get("humanApprovalRequiredAbove")),
        leverageAllowed: form.has("leverageAllowed")
      };
      const result = await postJson("/api/policy", payload);
      state.data = result.state;
      state.replayExecution = null;
      els.policyMessage.textContent = result.event?.dualSync?.synced
        ? "Saved and synced"
        : "Saved, replay pending";
      render();
      await checkHealth();
      await loadProof();
    } catch (error) {
      els.policyMessage.textContent = error.message;
    }
  });

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await postJson("/api/red-team", { scenario: button.dataset.scenario });
      state.data = result.state;
      render();
    });
  });

  els.tradeForm.elements.pair?.addEventListener("change", renderMarkets);
}

async function checkHealth() {
  const health = await getJson("/api/health");
  state.health = health;
  const adapterLive = health.adapter.source === "kraken-cli" || health.adapter.source === "kraken-public-api";
  const dualLive = isDualLive(health.dual);
  els.adapterStatus.textContent = health.adapter.source === "kraken-cli"
    ? "Kraken CLI live"
    : health.adapter.source === "kraken-public-api"
      ? "Kraken public API live"
      : "Simulator fallback";
  els.adapterStatus.classList.toggle("live", adapterLive);
  els.adapterStatus.classList.toggle("sim", !adapterLive);
  els.dualStatus.textContent = dualLive
    ? health.dual.writable ? "DUAL write-sync live" : "DUAL read-linked"
    : "DUAL local simulator";
  els.dualStatus.classList.toggle("live", dualLive);
  els.dualStatus.classList.toggle("sim", !dualLive || !health.dual.writable);
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
  renderBinding();
  renderTimeline();
}

function renderMarkets() {
  if (!state.data) return;
  const activePair = selectedPair();
  els.marketStrip.innerHTML = pairs.map((pair) => {
    const market = state.data.market[pair] || {};
    const change = Number(market.changePct || 0);
    const isPositive = change >= 0;
    return `
      <article class="ticker ${pair === activePair ? "active" : ""}">
        <div class="pair">${pair}</div>
        <div class="price">${formatMarketPrice(market.price)}</div>
        <div class="vol">VOL ${Number(market.volume || 0).toLocaleString()}</div>
        <div class="change ${isPositive ? "pos" : "neg"}">${isPositive ? "+" : ""}${change.toFixed(2)}%</div>
        <svg class="spark" viewBox="0 0 240 28" preserveAspectRatio="none" aria-hidden="true">
          <path d="${sparkPath(pair, isPositive)}" fill="none" stroke="${isPositive ? "var(--positive)" : "var(--negative)"}" stroke-width="1.2"></path>
        </svg>
      </article>
    `;
  }).join("");
  renderMarketTerminal(activePair);
}

function selectedPair() {
  return els.tradeForm?.elements?.pair?.value || "DUALUSD";
}

function renderMarketTerminal(pair = selectedPair()) {
  if (!els.marketStats || !els.orderBook || !els.depthMeter) return;
  const market = state.data?.market?.[pair] || {};
  const price = Number(market.price || 0);
  const spread = price ? Math.max(price * 0.0036, pair === "DUALUSD" ? 0.000001 : 0.01) : 0;
  const bid = Math.max(0, price - spread / 2);
  const ask = price + spread / 2;
  const spreadPct = price ? (spread / price) * 100 : 0;
  const volume = Number(market.volume || 0);
  const change = Number(market.changePct || 0);
  const bidDepth = Math.max(42, Math.min(84, 54 + Math.abs(change) * 5));
  const askDepth = Math.max(36, Math.min(78, 50 + Math.abs(change) * 4));
  const quotePair = pair.replace("USD", "/USD");
  const stats = [
    ["BID", formatMarketPrice(bid), "bid"],
    ["ASK", formatMarketPrice(ask), "ask"],
    ["SPREAD", `${formatMarketPrice(spread)} · ${spreadPct.toFixed(2)}%`, "spread"],
    ["24H VOL", compactNumber(volume), "vol"]
  ];
  const sizeBase = Math.max(1, volume / (pair === "DUALUSD" ? 36 : 72));
  const rows = [
    { side: "ask", label: "ASK", price: ask + spread * 0.9, size: sizeBase * 0.54 },
    { side: "ask", label: "ASK", price: ask, size: sizeBase * 0.82 },
    { side: "bid", label: "BID", price: bid, size: sizeBase },
    { side: "bid", label: "BID", price: Math.max(0, bid - spread * 0.9), size: sizeBase * 0.68 }
  ];
  const maxSize = Math.max(...rows.map((row) => row.size), 1);

  if (els.bookPair) els.bookPair.textContent = pair;
  els.marketStats.innerHTML = stats.map(([label, value, tone]) => `
    <div class="market-stat ${tone}">
      <span>${label}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
  els.orderBook.innerHTML = rows.map((row) => `
    <div class="book-row ${row.side}" style="--depth:${Math.round((row.size / maxSize) * 100)}%">
      <span>${row.label}</span>
      <strong>${formatMarketPrice(row.price)}</strong>
      <em>${compactNumber(row.size)}</em>
    </div>
  `).join("");
  els.depthMeter.innerHTML = `
    <div class="depth-meter-head">
      <span>${quotePair} depth</span>
      <strong>${change >= 0 ? "+" : ""}${change.toFixed(2)}%</strong>
    </div>
    <div class="depth-bar" aria-label="Bid and ask depth">
      <span class="bid" style="width:${bidDepth}%"></span>
      <span class="ask" style="width:${askDepth}%"></span>
    </div>
  `;
}

function sparkPath(pair, positive = true) {
  const seeds = {
    BTCUSD: positive ? [6, 11, 9, 14, 13, 17, 15, 20] : [20, 15, 17, 13, 14, 9, 11, 6],
    ETHUSD: positive ? [8, 7, 11, 10, 14, 13, 18, 17] : [17, 18, 13, 14, 10, 11, 7, 8],
    SOLUSD: positive ? [5, 8, 6, 12, 11, 16, 14, 19] : [19, 14, 16, 11, 12, 6, 8, 5],
    DUALUSD: positive ? [4, 6, 7, 10, 9, 13, 15, 21] : [21, 15, 13, 9, 10, 7, 6, 4]
  };
  const points = seeds[pair] || seeds.BTCUSD;
  const max = Math.max(...points);
  const min = Math.min(...points);
  return points.map((point, index) => {
    const x = 4 + index * 33;
    const y = 24 - ((point - min) / Math.max(1, max - min)) * 20;
    return `${index ? "L" : "M"}${x} ${y.toFixed(1)}`;
  }).join(" ");
}

function renderPairChips(allowedPairs = []) {
  return `<span class="pair-chips">${pairs.map((pair) => `
    <span class="pair-chip ${allowedPairs.includes(pair) ? "" : "off"}">${pair}</span>
  `).join("")}</span>`;
}

function renderDailyBar(passport) {
  const used = Number(passport.dailyNotionalUsed || 0);
  const cap = Number(passport.maxDailyNotionalUsd || 1);
  const pct = Math.min(100, Math.max(0, (used / cap) * 100));
  return `<span class="daily-bar"><span class="fill ${pct > 80 ? "high" : ""}" style="width: ${pct}%"></span></span>`;
}

function renderPassport() {
  const passport = state.data.passport;
  els.passportState.textContent = `${passport.agentName} · ${passport.mode.toUpperCase()} mode`;
  els.stateChip.textContent = passport.dualObjectState;
  els.stateChip.className = `state-chip ${passport.dualObjectState || "active"}`;
  const rows = [
    ["Allowed pairs", renderPairChips(passport.allowedPairs)],
    ["Max trade", money.format(passport.maxNotionalUsd)],
    ["Daily cap", `${money.format(passport.dailyNotionalUsed)} / ${money.format(passport.maxDailyNotionalUsd)}${renderDailyBar(passport)}`],
    ["Leverage", passport.leverageAllowed ? "Allowed" : "Blocked"],
    ["Approval threshold", money.format(passport.humanApprovalRequiredAbove)],
    ["Policy", passport.approvalPolicy.replaceAll("_", " ")]
  ];

  els.mandateList.innerHTML = rows.map(([label, value]) => `
    <div class="mandate-row">
      <span class="k">${label}</span>
      <strong class="v">${value}</strong>
    </div>
  `).join("");

  renderPolicyForm(passport);
}

function renderPolicyForm(passport) {
  if (els.policyForm.matches(":focus-within")) return;
  document.querySelectorAll('input[name="allowedPairs"]').forEach((input) => {
    input.checked = passport.allowedPairs.includes(input.value);
  });
  els.policyMaxTrade.value = passport.maxNotionalUsd;
  els.policyDailyCap.value = passport.maxDailyNotionalUsd;
  els.policyApprovalThreshold.value = passport.humanApprovalRequiredAbove;
  els.policyLeverageAllowed.checked = Boolean(passport.leverageAllowed);
}

function renderProposal() {
  const proposal = state.data.proposals.find((item) => item.id === state.activeProposalId) || state.data.proposals[0];
  if (!proposal) {
    els.proposalCard.className = "proposal empty";
    els.proposalCard.innerHTML = `
      <div class="empty-proposal">
        <span>No active proposal</span>
        <strong>Create a DUAL/USD trade intent to see the mandate decision.</strong>
      </div>
    `;
    els.approveButton.disabled = true;
    els.executeButton.disabled = true;
    return;
  }

  state.activeProposalId = proposal.id;
  const policy = proposal.policy;
  const marketPrice = proposal.trade.price || state.data.market?.[proposal.trade.pair]?.price || 0;
  const quantity = proposal.trade.quantity || (marketPrice ? policy.notional / marketPrice : 0);
  const policyHash = state.data.passport.policyHash || "";
  const policyVersion = state.data.passport.policyVersion || "1";
  const statusClass = policy.decision === "block" ? "blocked" : policy.decision === "needs_approval" ? "pending" : "allowed";
  const message = policy.violations[0] || policy.warnings[0] || "Ready for paper execution.";
  els.proposalCard.className = `proposal ${statusClass === "blocked" ? "state-blocked" : ""}`;
  els.proposalCard.innerHTML = `
    <div class="prop-head">
      <div>
        <div class="id">${proposal.id.toUpperCase()}</div>
        <div class="summary">
          <span class="side ${proposal.trade.side}">${proposal.trade.side.toUpperCase()}</span>
          <b>${proposal.trade.pair}</b>
          <span class="price-context">@ ${formatMarketPrice(marketPrice)}</span>
        </div>
      </div>
      <div class="notional">
        ${money.format(policy.notional)}
        <small>notional</small>
      </div>
    </div>
    <div class="flow">
      ${renderProposalStep("proposed", "Proposed", `<b>${proposal.trade.side.toUpperCase()} ${proposal.trade.pair}</b><br>${money.format(policy.notional)} · ${Number(quantity || 0).toFixed(6)} ${proposal.trade.pair.replace("USD", "")}`, "done")}
      ${renderProposalStep("policy", "Policy check", policy.decision === "block"
        ? `decision: <b class="negative">BLOCK</b><br>${message}`
        : `decision: <b class="positive">${policy.decision === "needs_approval" ? "NEEDS APPROVAL" : "ALLOW"}</b><br>v${policyVersion} · <span class="hash-mono">${shortId(policyHash)}</span>`, policy.decision === "block" ? "blocked" : "done")}
      ${renderProposalStep("approval", "Human gate", policy.decision === "needs_approval"
        ? proposal.state === "approved" || proposal.state === "executed"
          ? "approved · operator"
          : "awaiting human"
        : "auto · under threshold", policy.decision === "needs_approval" && proposal.state !== "approved" && proposal.state !== "executed" ? "needs" : "done")}
      ${renderProposalStep("executed", "Paper exec", proposal.state === "executed"
        ? `<b class="positive">FILLED</b> · ${proposal.result?.source || "simulated-paper"}<br>digest <span class="hash-mono">${shortId(proposal.result?.digest || "")}</span>`
        : proposal.state === "approved"
          ? "ready to execute"
          : "pending", proposal.state === "executed" ? "done" : proposal.state === "approved" ? "active" : "pending")}
    </div>
    <div class="prop-actions">
      <span>${proposal.tradeReceipt ? `receipt <span class="hash-mono">${shortId(proposal.tradeReceipt.id)}</span> · ${tradeReceiptSyncLabel(proposal.tradeReceipt)}` : message}</span>
      <strong>${proposal.state.replaceAll("_", " ")}</strong>
    </div>
  `;
  els.approveButton.disabled = proposal.state !== "awaiting_approval";
  els.executeButton.disabled = proposal.state !== "approved";
}

function renderProposalStep(key, label, detail, cls) {
  return `
    <div class="flow-step ${cls}" data-step="${key}">
      <div class="step-label"><span>${label}</span></div>
      <div class="step-detail">${detail}</div>
    </div>
  `;
}

function renderTimeline() {
  const audit = state.data.audit || [];
  els.eventCount.textContent = `${audit.length} events`;
  els.timeline.innerHTML = audit.slice(0, 3).map((event) => `
    <li class="term-line fade-in">
      <span class="ts">${new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <span class="src ${timelineSourceClass(event)}">${timelineSourceLabel(event)}</span>
      <span class="msg"><b>${event.title}</b> · ${event.detail} · <span class="hash">${event.provenanceHash ? event.provenanceHash.slice(0, 12) : event.id}</span></span>
    </li>
  `).join("");
}

function timelineSourceClass(event) {
  if (event.type?.includes("market")) return "krk";
  if (event.type?.includes("red")) return "err";
  if (event.status === "blocked" || event.status === "error") return "err";
  if (event.status === "executed" || event.status === "approved") return "ok";
  if (event.type?.includes("proposal") || event.type?.includes("policy") || event.type?.includes("passport")) return "dual";
  return "sys";
}

function timelineSourceLabel(event) {
  const source = timelineSourceClass(event);
  if (source === "krk") return "kraken >";
  if (source === "dual") return "dual >";
  if (source === "ok") return "ok >";
  if (source === "err") return "err >";
  return "sys >";
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
  renderOptionalEmailAuth();
  const dual = proof?.status?.dualMode || state.health?.dual;
  const adapter = proof?.status?.krakenMarketData || state.health?.adapter?.source || "checking";
  const dualObject = proof?.dualObject;
  const dualTemplate = proof?.dualTemplate;
  const dualBatch = proof?.dualBatch;
  const replayQueue = proof?.replayQueue;
  const tradeReceipts = proof?.tradeReceipts;
  const policy = proof?.policy;
  const settlement = proof?.settlement;
  const eventBusSync = verifier?.checks?.find((check) => check.id === "dual-event-bus-sync");
  const replayExecutionLabel = state.replayExecution?.executedCount != null
    ? `${state.replayExecution.executedCount} writes / ${state.replayExecution.skippedCount || 0} skipped`
    : eventBusSync?.ok
      ? replayQueue?.pendingCount
        ? `${replayQueue.syncedCount || 0} synced, ${replayQueue.pendingCount} pending`
        : `${replayQueue?.syncedCount ?? replayQueue?.eventCount ?? 0} synced`
      : "not executed";
  const replayQueueLabel = replayQueue?.eventCount != null
    ? `${replayQueue.pendingCount ?? replayQueue.eventCount} pending / ${replayQueue.eventCount} total`
    : "pending";
  const receiptReplayLabel = state.tradeReceiptReplay?.executedCount != null
    ? `${state.tradeReceiptReplay.executedCount} minted / ${state.tradeReceiptReplay.skippedCount || 0} skipped`
    : tradeReceipts?.receiptCount != null
      ? `${tradeReceipts.syncedCount || 0} minted, ${tradeReceipts.pendingCount || 0} pending`
      : "pending";
  const writeReadiness = proof?.status?.writeReadiness || dual?.writeReadiness;
  const writeGate = writeReadiness?.writeGate || dual?.writeGate || auth?.writeGate;
  const writeReadyNow = Boolean(
    writeReadiness?.canWriteNow
    ?? writeReadiness?.ready
    ?? dual?.canWriteNow
    ?? (dual?.writable && writeGate?.allowed)
  );
  const rows = [
    ["Kraken market", sourceLabel(adapter)],
    ["Paper execution", proof?.status?.krakenPaperExecution || "simulated-paper"],
    ["DUAL mode", isDualLive(dual) ? dual.writable ? "write-sync" : "read-linked" : "local simulator"],
    ["Write readiness", writeReadyNow ? "ready" : writeReadiness?.persistenceReady || dual?.persistenceReady ? "public writes disabled" : "needs DUAL write config"],
    ["Write gate", writeGate?.allowed ? "public demo writes" : "disabled"],
    ["Write auth", authLabel(auth)],
    ["L3 action", settlementValue(settlement, "l3-action")],
    ["L2 batch", settlementValue(settlement, "l2-batch")],
    ["L1 roll-up", settlementValue(settlement, "l1-rollup")],
    ["Mandate source", dualTemplate?.available ? "DUAL template" : "local seed"],
    ["DUAL object", dualObject?.available ? shortId(dualObject.id) : shortId(dual?.objectId || "pending")],
    ["Policy version", policy?.version ? `v${policy.version}` : "pending"],
    ["Policy hash", policy?.hash ? shortId(policy.hash) : "pending"],
    ["Action setup", state.actionPassportSetup?.vercelEnv ? `${shortId(state.actionPassportSetup.vercelEnv.DUAL_AGENT_PASSPORT_TEMPLATE_ID)} / ${shortId(state.actionPassportSetup.vercelEnv.DUAL_AGENT_PASSPORT_OBJECT_ID)}` : "not run"],
    ["Receipt template", tradeReceipts?.targetTemplateId ? shortId(tradeReceipts.targetTemplateId) : state.tradeReceiptTemplateSetup?.vercelEnv ? shortId(state.tradeReceiptTemplateSetup.vercelEnv.DUAL_TRADE_RECEIPT_TEMPLATE_ID) : "not configured"],
    ["Trade receipts", tradeReceipts?.receiptCount != null ? `${tradeReceipts.receiptCount} receipts` : "pending"],
    ["Receipt minting", receiptReplayLabel],
    ["Replay queue", replayQueueLabel],
    ["Replay execution", replayExecutionLabel],
    ["DUAL actions", replayQueue?.syncedCount != null ? `${replayQueue.syncedCount} action ids` : "pending"],
    ["DUAL batch", dualBatch?.available ? `${shortId(dualBatch.id)} ${dualBatch.status || dualBatch.finality || "pending"}` : "not readable"],
    ["Batch proof", dualBatch?.available ? batchProofLabel(dualBatch) : "pending"],
    ["Replay root", replayQueue?.rootHash ? shortId(replayQueue.rootHash) : "pending"],
    ["Pending root", replayQueue?.pendingRootHash ? shortId(replayQueue.pendingRootHash) : "pending"],
    ["Receipt root", tradeReceipts?.rootHash ? shortId(tradeReceipts.rootHash) : "pending"],
    ["Audit root", proof?.audit?.rootHash ? shortId(proof.audit.rootHash) : "pending"],
    ["Proof hash", proof?.proofHash ? shortId(proof.proofHash) : "pending"],
    ["Verifier", verifier ? verifier.complete ? "complete" : verifier.ok ? verifier.status.replaceAll("_", " ") : "checks pending" : "pending"]
  ];

  els.proofGrid.innerHTML = compactProofRows(rows).map(([label, value]) => `
    <div class="proof-cell">
      <div class="k">${label}</div>
      <div class="v">${value}</div>
    </div>
  `).join("");

  renderSettlementRoute(settlement);
  renderDualLinks(proof?.links || state.health?.dual?.links || dual?.links || []);
  renderBinding();

  const writeReady = writeReadyNow;
  els.executeReplayButton.disabled = !writeReady || !(replayQueue?.pendingCount ?? replayQueue?.eventCount);
  els.setupActionPassportButton.disabled = !writeReady;
  els.setupReceiptTemplateButton.disabled = !writeReady;
  els.executeReceiptReplayButton.disabled = !writeReady || !tradeReceipts?.writable || !tradeReceipts?.pendingCount;
  if (auth?.authenticated) {
    els.dualAuthMessage.textContent = auth.detail;
  } else if (writeReady) {
    els.dualAuthMessage.textContent = "Public demo DUAL writes are enabled.";
  } else if (writeGate?.allowed) {
    els.dualAuthMessage.textContent = "Public demo write gate is open; DUAL write readiness still needs server-side config.";
  } else if (!els.dualAuthMessage.textContent) {
    els.dualAuthMessage.textContent = auth?.detail || "Scoped API-key auth controls live DUAL writes for this public demo.";
  }
}

function renderBinding() {
  if (!els.bindingChain) return;
  const items = dualBindingItems();
  const liveCount = items.filter((item) => item.ready).length;
  if (els.bindingSummary) {
    els.bindingSummary.textContent = `${liveCount}/${items.length} live bindings`;
    els.bindingSummary.className = `binding-score ${liveCount === items.length ? "complete" : liveCount ? "partial" : ""}`;
  }
  els.bindingChain.innerHTML = items.map((item, index) => `
    <article class="binding-node ${item.ready ? "ready" : "pending"}">
      <div class="node-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="node-body">
        <span class="node-label">${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
        <code>${escapeHtml(shortId(item.id || "pending"))}</code>
      </div>
      <div class="node-links">
        ${renderBindingTargets(item.link)}
      </div>
    </article>
  `).join("");
}

function dualBindingItems() {
  const proof = state.proof || {};
  const dual = proof.status?.dualMode || state.health?.dual || {};
  const dualTemplate = proof.dualTemplate;
  const dualObject = proof.dualObject;
  const tradeReceipts = proof.tradeReceipts || {};
  const replayQueue = proof.replayQueue || {};
  const dualBatch = proof.dualBatch || {};
  const latestReplay = firstWithActionId(replayQueue.latest || []);
  const latestReceipt = firstSyncedReceipt(tradeReceipts.latest || []);
  const latestBatchAction = latestActionFromBatch(dualBatch);
  const actionId = latestReplay?.actionId || latestReplay?.dualSync?.result?.actionId || latestBatchAction?.id || "";
  const actionHash = latestReplay?.dualSync?.result?.hash || latestBatchAction?.hash || "";
  const receiptObjectId = latestReceipt?.dualSync?.result?.id || "";
  const receiptActionId = latestReceipt?.dualSync?.result?.actionId || "";
  const policy = proof.policy || {};

  return [
    {
      label: "Mandate template",
      title: "Rules become schema",
      detail: dualTemplate?.available ? "The agent mandate is read from a DUAL template." : "Waiting for a readable DUAL template.",
      id: dualTemplate?.id || dual.templateId,
      ready: Boolean(dualTemplate?.available || dual.templateId),
      link: proofLink("dual-record-template")
    },
    {
      label: "Passport object",
      title: "Agent state is bound",
      detail: dualObject?.available ? "Policy limits, state, and latest event pointer are on the DUAL object." : "Waiting for passport object readback.",
      id: dualObject?.id || dual.objectId,
      ready: Boolean(dualObject?.available || dual.objectId),
      link: proofLink("dual-record-object")
    },
    {
      label: "Policy hash",
      title: "Mandate is fingerprinted",
      detail: policy.hash ? `Policy v${policy.version || 1} is committed into the proof bundle.` : "Waiting for policy hash.",
      id: policy.hash || state.data?.passport?.policyHash,
      ready: Boolean(policy.hash || state.data?.passport?.policyHash),
      link: proofLink("dual-record-object")
    },
    {
      label: "Action log",
      title: "Execution creates DUAL action",
      detail: actionId ? "The latest governed trade event has a DUAL action id." : "Waiting for a synced DUAL action.",
      id: actionId || actionHash,
      ready: Boolean(actionId),
      link: proofLink(`dual-record-action-${actionId}`) || proofLink("dual-record-action")
    },
    {
      label: "Receipt object",
      title: "Trade receipt minted",
      detail: receiptObjectId ? "The paper trade receipt exists as a DUAL object." : "Waiting for a minted receipt object.",
      id: receiptObjectId || receiptActionId,
      ready: Boolean(receiptObjectId || receiptActionId),
      link: proofLink("dual-record-receipt-object")
    },
    {
      label: "Batch proof",
      title: "Actions enter batch proof",
      detail: dualBatch?.available ? batchProofLabel(dualBatch) : "Waiting for DUAL batch readback.",
      id: dualBatch?.id,
      ready: Boolean(dualBatch?.available),
      link: proofLink("dual-record-batch")
    }
  ];
}

function firstWithActionId(events = []) {
  return events.find((event) => event?.actionId || event?.dualSync?.result?.actionId) || null;
}

function firstSyncedReceipt(receipts = []) {
  return receipts.find((receipt) => receipt?.dualSync?.synced) || receipts.find((receipt) => receipt?.dualSync?.result?.id) || null;
}

function latestActionFromBatch(batch = {}) {
  const actions = batch.affectedActions || [];
  return actions.length ? actions[actions.length - 1] : null;
}

function proofLink(id) {
  return (state.proof?.links || state.health?.dual?.links || []).find((link) => link.id === id) || null;
}

function renderBindingTargets(link) {
  if (!link?.href) return `<span class="binding-target muted">pending</span>`;
  const targets = link.targets?.length ? link.targets : [{ label: link.source || "Open", href: link.href, source: link.source }];
  return targets.slice(0, 3).map((target) => `
    <a class="binding-target ${dualLinkSourceClass(target.source)}" href="${escapeHtml(target.href)}" target="_blank" rel="noreferrer">
      ${escapeHtml(target.label || "Open")}
    </a>
  `).join("");
}

function renderOptionalEmailAuth() {
  const enabled = Boolean(state.dualAuth?.emailCodeAuthEnabled && state.dualAuth?.enabled);
  els.dualEmailAuthPanel?.classList.toggle("hidden", !enabled);
  if (els.requestCodeButton) els.requestCodeButton.disabled = !enabled;
  if (els.verifyCodeButton) els.verifyCodeButton.disabled = !enabled;
}

function renderDualLinks(links) {
  if (!els.dualLinks) return;
  const uniqueLinks = [...new Map((links || [])
    .filter((link) => link?.href)
    .map((link) => [link.id || link.href, link])).values()];
  if (!uniqueLinks.length) {
    els.dualLinks.innerHTML = `<div class="link-empty">DUAL record links appear when proof readback data is available.</div>`;
    return;
  }
  els.dualLinks.innerHTML = compactDualLinks(uniqueLinks).map((link) => `
    <div class="dual-link ${dualLinkSourceClass(link.source)}">
      <a class="dual-link-main" href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">
        <span>${escapeHtml(link.label || "DUAL data")}</span>
        <strong>${escapeHtml(link.detail || "Open data")}</strong>
      </a>
      ${renderDualLinkTargets(link.targets)}
    </div>
  `).join("");
}

function renderSettlementRoute(settlement) {
  if (!els.settlementRail) return;
  const layers = settlement?.layers || [];
  if (!layers.length) {
    els.settlementRail.innerHTML = `
      <div class="settlement-step pending">
        <span>Settlement</span>
        <strong>L3 -> L2 -> L1</strong>
        <em>pending</em>
      </div>
    `;
    return;
  }
  els.settlementRail.innerHTML = layers.map((layer) => {
    const className = `settlement-step ${dualLinkSourceClass(layer.source)} ${layer.href ? "ready" : "pending"}`;
    const body = `
      <span>${escapeHtml(layer.label)}</span>
      <strong>${escapeHtml(layer.detail || "pending")}</strong>
      <em>${escapeHtml(layer.status || "pending")}</em>
    `;
    return layer.href
      ? `<a class="${className}" href="${escapeHtml(layer.href)}" target="_blank" rel="noreferrer">${body}</a>`
      : `<div class="${className}">${body}</div>`;
  }).join("");
}

function compactProofRows(rows) {
  const byLabel = new Map(rows);
  const labels = [
    "Kraken market",
    "Paper execution",
    "DUAL mode",
    "L3 action",
    "L2 batch",
    "L1 roll-up",
    "DUAL object",
    "DUAL actions",
    "Batch proof"
  ];
  return labels
    .map((label) => [label, byLabel.get(label)])
    .filter(([, value]) => value != null);
}

function compactDualLinks(links) {
  const actionLinks = links.filter((link) => link.id?.startsWith("dual-record-action"));
  const latestAction = actionLinks[actionLinks.length - 1];
  const priority = [
    "console-dashboard",
    "dual-record-template",
    "dual-record-object",
    "dual-record-batch",
    "dual-record-receipt-object",
    "dual-record-receipt-template"
  ];
  const selected = [];
  for (const id of priority) {
    const match = links.find((link) => link.id === id);
    if (match) selected.push(match);
  }
  if (latestAction) selected.splice(3, 0, latestAction);
  return [...new Map(selected.map((link) => [link.id || link.href, link])).values()].slice(0, 6);
}

function renderDualLinkTargets(targets = []) {
  const uniqueTargets = [...new Map((targets || [])
    .filter((target) => target?.href)
    .map((target) => [`${target.label || target.source}:${target.href}`, target])).values()];
  if (!uniqueTargets.length) return "";
  return `
    <div class="dual-link-targets">
      ${uniqueTargets.map((target) => `
        <a class="dual-link-target ${dualLinkSourceClass(target.source)}" href="${escapeHtml(target.href)}" target="_blank" rel="noreferrer">
          ${escapeHtml(target.label || "Open")}
        </a>
      `).join("")}
    </div>
  `;
}

function dualLinkSourceClass(source) {
  if (source === "blockscout" || source === "l3-explorer" || source === "l2-explorer" || source === "l1-rollup") return "explorer";
  if (source === "dual-record") return "record";
  if (source === "console") return "console";
  return "";
}

function settlementValue(settlement, id) {
  const layer = settlement?.layers?.find((item) => item.id === id);
  return layer?.detail || layer?.status || "pending";
}

function sourceLabel(source) {
  if (source === "kraken-cli") return "Kraken CLI";
  if (source === "kraken-public-api") return "Kraken public API";
  return source || "simulator";
}

function isDualLive(dual) {
  return dual?.mode === "dual" && Boolean(dual.available);
}

function batchProofLabel(batch) {
  if (batch.finality === "finalized") return batch.transactionHash ? `finalized ${shortId(batch.transactionHash)}` : "finalized";
  if (batch.finality === "proof-success") return batch.proofValue ? `proof ${batch.proofValue}` : "proof success";
  if (batch.proofValue) return `proof ${batch.proofValue}`;
  return batch.finality || "pending";
}

function authLabel(auth) {
  if (auth?.authType === "api_key_env") return "API key";
  if (auth?.authType === "both_env") return "legacy API key";
  if (auth?.authType === "api_key_service_account") return "service API key";
  if (auth?.authType === "bearer_service_account") return "service bearer";
  if (auth?.authType === "both_service_account") return "service legacy API key";
  if (auth?.authType === "bearer_env") return "bearer env";
  if (auth?.authenticated && auth.email) return `session ${auth.email}`;
  if (auth?.pendingEmail) return `code sent ${auth.pendingEmail}`;
  if (auth?.serviceAccountConfigured) return "service account pending write mode";
  if (auth && auth.emailCodeAuthEnabled === false) return "write auth needed";
  return "write auth needed";
}

function tradeReceiptSyncLabel(receipt) {
  if (receipt?.dualSync?.synced) return "DUAL receipt object minted";
  if (receipt?.dualSync?.error) return `DUAL mint failed: ${receipt.dualSync.error}`;
  if (receipt?.dualSync?.reason) return `local receipt only: ${receipt.dualSync.reason}`;
  return "DUAL mint pending";
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 16) return text || "pending";
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function formatMarketPrice(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount > 0 && amount < 1 ? 6 : 2,
    maximumFractionDigits: amount > 0 && amount < 1 ? 6 : 2
  }).format(amount);
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Number(value || 0));
}

async function getJson(url, options = {}) {
  const response = await fetch(url, { headers: requestHeaders(options) });
  if (!response.ok) throw new Error(`GET ${url} failed`);
  return response.json();
}

async function postJson(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders({ ...options, contentType: true }),
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok && response.status !== 409) {
    throw new Error(errorMessage(body, `POST ${url} failed`));
  }
  return body;
}

function requestHeaders(options = {}) {
  const headers = {};
  if (options.contentType) headers["content-type"] = "application/json";
  return headers;
}

function errorMessage(body, fallback) {
  if (body?.detail?.attempts?.length) {
    return body.detail.attempts.map((attempt) => `${attempt.style}: ${attempt.message}`).join(" | ");
  }
  return body?.message || body?.error || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
