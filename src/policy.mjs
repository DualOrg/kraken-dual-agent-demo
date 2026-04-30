export function evaluateTrade(passport, trade) {
  const violations = [];
  const warnings = [];
  const quantity = Number(trade.quantity || 0);
  const price = Number(trade.price || 0);
  const notional = roundMoney(quantity * price);
  const pair = String(trade.pair || "").toUpperCase();
  const side = String(trade.side || "").toLowerCase();
  const leverage = Number(trade.leverage || 1);
  const approved = Boolean(trade.approved);

  if (!["buy", "sell"].includes(side)) {
    violations.push("Unsupported side. Use buy or sell.");
  }

  if (!passport.allowedPairs.includes(pair)) {
    violations.push(`${pair || "Unknown pair"} is not in the allowed pair list.`);
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    violations.push("Quantity must be greater than zero.");
  }

  if (!Number.isFinite(price) || price <= 0) {
    violations.push("A valid market price is required.");
  }

  if (notional > passport.maxNotionalUsd) {
    violations.push(`Trade notional $${notional} exceeds per-trade cap $${passport.maxNotionalUsd}.`);
  }

  if (passport.dailyNotionalUsed + notional > passport.maxDailyNotionalUsd) {
    violations.push(`Daily notional would exceed $${passport.maxDailyNotionalUsd}.`);
  }

  if (leverage > 1 && !passport.leverageAllowed) {
    violations.push("Leverage is blocked by the DUAL mandate.");
  }

  if (notional > passport.humanApprovalRequiredAbove && !approved) {
    warnings.push(`Human approval required above $${passport.humanApprovalRequiredAbove}.`);
  }

  const decision = violations.length ? "block" : warnings.length ? "needs_approval" : "allow";

  return {
    decision,
    notional,
    violations,
    warnings,
    checkedAt: new Date().toISOString(),
    rules: {
      allowedPairs: passport.allowedPairs,
      maxNotionalUsd: passport.maxNotionalUsd,
      maxDailyNotionalUsd: passport.maxDailyNotionalUsd,
      leverageAllowed: passport.leverageAllowed,
      humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove
    }
  };
}

export function redTeamTrade(scenario, passport, market) {
  const btc = market.BTCUSD?.price || 67000;
  const eth = market.ETHUSD?.price || 3500;

  const scenarios = {
    oversized: {
      pair: "BTCUSD",
      side: "buy",
      quantity: roundQty((passport.maxNotionalUsd * 1.6) / btc),
      price: btc,
      leverage: 1,
      approved: false,
      label: "Oversized order"
    },
    blocked_pair: {
      pair: "DOGEUSD",
      side: "buy",
      quantity: 100,
      price: 0.18,
      leverage: 1,
      approved: false,
      label: "Blocked pair"
    },
    leverage: {
      pair: "ETHUSD",
      side: "buy",
      quantity: roundQty(100 / eth),
      price: eth,
      leverage: 5,
      approved: false,
      label: "Leverage attempt"
    },
    missing_approval: {
      pair: "BTCUSD",
      side: "buy",
      quantity: roundQty((passport.humanApprovalRequiredAbove + 25) / btc),
      price: btc,
      leverage: 1,
      approved: false,
      label: "Missing approval"
    }
  };

  return scenarios[scenario] || scenarios.oversized;
}

export function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function roundQty(value) {
  return Math.round(Number(value || 0) * 100000000) / 100000000;
}
