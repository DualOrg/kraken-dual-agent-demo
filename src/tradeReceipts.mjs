import crypto from "node:crypto";

export function createTradeReceipt(passport, proposal, event, result) {
  const trade = proposal.trade || {};
  const policy = proposal.policy || {};
  const agentMandate = policy.agentMandate || {};
  const agentMandateProof = agentMandate.proof || {};
  const autoChain = policy.autoChain || {};
  const autoChainProof = autoChain.proof || {};
  const autoChainClaim = autoChain.claim || {};
  const executedAt = proposal.executedAt || event.timestamp || new Date().toISOString();
  const receiptBase = {
    passportId: passport.id,
    agentName: passport.agentName,
    proposalId: proposal.id,
    pair: trade.pair,
    side: trade.side,
    quantity: Number(trade.quantity || 0),
    priceUsd: Number(trade.price || 0),
    notionalUsd: Number(policy.notional || 0),
    policyDecision: policy.decision || "allow",
    policyVersion: Number(passport.policyVersion || 1),
    policyHash: passport.policyHash || hashJson(policySnapshot(passport)),
    agentMandateResult: agentMandate.result || null,
    agentMandateCode: agentMandate.code || null,
    agentMandateReason: agentMandate.reason || null,
    agentMandateObjectId: agentMandateProof.objectId || agentMandate.objectId || null,
    agentMandateDecisionHash: agentMandateProof.decisionHash || null,
    agentMandatePolicyHash: agentMandateProof.policyHash || null,
    agentMandateHash: agentMandateProof.mandateHash || null,
    autoChainResult: autoChain.result || null,
    autoChainCode: autoChain.code || null,
    autoChainReason: autoChain.reason || null,
    autoChainClaimId: autoChainClaim.claimId || null,
    autoChainClaimState: autoChainClaim.state || null,
    autoChainNextGate: autoChainClaim.nextGate || null,
    autoChainObjectId: autoChainProof.objectId || autoChain.objectId || null,
    autoChainDecisionHash: autoChainProof.decisionHash || null,
    autoChainStateHash: autoChainProof.stateHash || null,
    executionDigest: result.digest || null,
    executionSource: result.source || null,
    executionMode: "paper",
    eventId: event.id,
    eventHash: event.provenanceHash || event.id,
    executedAt
  };
  const receiptHash = hashJson(receiptBase);
  return {
    id: `tr-${receiptHash.slice(0, 12)}`,
    schemaVersion: "dual-kraken-trade-receipt.v1",
    status: "executed",
    ...receiptBase,
    receiptHash,
    createdAt: new Date().toISOString(),
    dualSync: {
      synced: false,
      reason: "DUAL trade receipt minting has not run."
    }
  };
}

export function tradeReceiptProperties(receipt = {}) {
  return {
    receipt_id: receipt.id || "tr-pending",
    schema_version: receipt.schemaVersion || "dual-kraken-trade-receipt.v1",
    passport_id: receipt.passportId || "dual-passport-kraken-market-agent",
    agent_name: receipt.agentName || "Kraken Market Agent",
    proposal_id: receipt.proposalId || "",
    trade_pair: receipt.pair || "DUALUSD",
    trade_side: receipt.side || "buy",
    trade_quantity: String(receipt.quantity || 0),
    trade_price_usd: String(receipt.priceUsd || 0),
    notional_usd: String(receipt.notionalUsd || 0),
    policy_decision: receipt.policyDecision || "allow",
    policy_version: String(receipt.policyVersion || 1),
    policy_hash: receipt.policyHash || "",
    agent_mandate_result: receipt.agentMandateResult || "",
    agent_mandate_code: receipt.agentMandateCode || "",
    agent_mandate_reason: receipt.agentMandateReason || "",
    agent_mandate_object_id: receipt.agentMandateObjectId || "",
    agent_mandate_decision_hash: receipt.agentMandateDecisionHash || "",
    agent_mandate_policy_hash: receipt.agentMandatePolicyHash || "",
    agent_mandate_hash: receipt.agentMandateHash || "",
    execution_mode: receipt.executionMode || "paper",
    execution_source: receipt.executionSource || "",
    execution_digest: receipt.executionDigest || "",
    event_id: receipt.eventId || "",
    event_hash: receipt.eventHash || "",
    receipt_hash: receipt.receiptHash || hashJson(receipt),
    status: receipt.status || "executed",
    executed_at: receipt.executedAt || new Date().toISOString()
  };
}

export function tradeReceiptMetadata(receipt = {}) {
  return {
    source: "kraken_dual_trade_receipt",
    event_id: receipt.eventId || "",
    event_type: "trade_receipt_minted",
    event_status: receipt.status || "executed",
    event_hash: receipt.eventHash || receipt.receiptHash || "",
    receipt_id: receipt.id || "",
    receipt_hash: receipt.receiptHash || ""
  };
}

export function summarizeTradeReceipt(receipt = {}) {
  return {
    id: receipt.id || null,
    proposalId: receipt.proposalId || null,
    pair: receipt.pair || null,
    side: receipt.side || null,
    quantity: receipt.quantity ?? null,
    priceUsd: receipt.priceUsd ?? null,
    notionalUsd: receipt.notionalUsd ?? null,
    policyDecision: receipt.policyDecision || null,
    policyHash: receipt.policyHash || null,
    agentMandate: {
      result: receipt.agentMandateResult || null,
      code: receipt.agentMandateCode || null,
      reason: receipt.agentMandateReason || null,
      objectId: receipt.agentMandateObjectId || null,
      decisionHash: receipt.agentMandateDecisionHash || null,
      policyHash: receipt.agentMandatePolicyHash || null,
      mandateHash: receipt.agentMandateHash || null
    },
    autoChain: {
      result: receipt.autoChainResult || null,
      code: receipt.autoChainCode || null,
      reason: receipt.autoChainReason || null,
      claimId: receipt.autoChainClaimId || null,
      claimState: receipt.autoChainClaimState || null,
      nextGate: receipt.autoChainNextGate || null,
      objectId: receipt.autoChainObjectId || null,
      decisionHash: receipt.autoChainDecisionHash || null,
      stateHash: receipt.autoChainStateHash || null
    },
    executionSource: receipt.executionSource || null,
    executionMode: receipt.executionMode || null,
    executionDigest: receipt.executionDigest || null,
    receiptHash: receipt.receiptHash || null,
    executedAt: receipt.executedAt || null,
    dualSync: receipt.dualSync || null
  };
}

export function tradeReceiptRootItem(receipt = {}) {
  return {
    id: receipt.id,
    receiptHash: receipt.receiptHash,
    proposalId: receipt.proposalId,
    eventId: receipt.eventId,
    actionId: receipt.dualSync?.result?.actionId || null,
    objectId: receipt.dualSync?.result?.id || null,
    synced: Boolean(receipt.dualSync?.synced)
  };
}

export function hashJson(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function policySnapshot(passport = {}) {
  return {
    allowedPairs: passport.allowedPairs || [],
    maxNotionalUsd: passport.maxNotionalUsd || 0,
    maxDailyNotionalUsd: passport.maxDailyNotionalUsd || 0,
    leverageAllowed: Boolean(passport.leverageAllowed),
    humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove || 0,
    blockedActions: passport.blockedActions || [],
    approvalPolicy: passport.approvalPolicy || "human_required_above_threshold",
    policyVersion: passport.policyVersion || 1
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
