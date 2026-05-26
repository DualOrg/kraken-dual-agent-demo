import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadState, resetState, saveState, createAuditEvent, createProposal } from "./src/dualStore.mjs";
import { evaluateTrade, redTeamTrade, roundMoney, roundQty } from "./src/policy.mjs";
import { executePaperTrade, getAdapterStatus, getMarket } from "./src/krakenAdapter.mjs";
import { createDualPersistence } from "./src/dualPersistenceV3.mjs";
import {
  createTradeReceipt,
  summarizeTradeReceipt
} from "./src/tradeReceipts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const publicDir = join(root, "public");
await loadDotEnv();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const dualPersistence = await createDualPersistence();
const dualSessionCookieName = "__Host-dual_kraken_session";
const publicDualWrites = process.env.DEMO_PUBLIC_DUAL_WRITES === undefined
  ? true
  : parseBoolean(process.env.DEMO_PUBLIC_DUAL_WRITES);
const emailCodeAuthEnabled = parseBoolean(process.env.DEMO_ENABLE_EMAIL_AUTH || "false");
const dualConsoleBaseUrl = normalizeExternalBaseUrl(process.env.DUAL_CONSOLE_BASE_URL || "https://console-testnet.dual.network");
const dualL3ExplorerBaseUrl = normalizeExternalBaseUrl(process.env.DUAL_L3_EXPLORER_BASE_URL || "https://explorer-testnet.dual.network");
const dualL2ExplorerBaseUrl = normalizeExternalBaseUrl(
  process.env.DUAL_L2_EXPLORER_BASE_URL || process.env.DUAL_BLOCKSCOUT_BASE_URL || "https://explorer-test-v2.dual.network"
);
const dualL1ExplorerBaseUrl = normalizeExternalBaseUrl(process.env.DUAL_L1_EXPLORER_BASE_URL || "");
const dualLinkTemplates = {
  consoleOrg: process.env.DUAL_CONSOLE_ORG_URL_TEMPLATE || (dualConsoleBaseUrl ? `${dualConsoleBaseUrl}/{orgId}` : ""),
  consoleTemplate: process.env.DUAL_CONSOLE_TEMPLATE_URL_TEMPLATE || (dualConsoleBaseUrl ? `${dualConsoleBaseUrl}/{orgId}/collections/templates?templateId={templateId}` : ""),
  consoleObject: process.env.DUAL_CONSOLE_OBJECT_URL_TEMPLATE || (dualConsoleBaseUrl ? `${dualConsoleBaseUrl}/{orgId}/collections/objects?objectId={objectId}` : ""),
  consoleAction: process.env.DUAL_CONSOLE_ACTION_URL_TEMPLATE || (dualConsoleBaseUrl ? `${dualConsoleBaseUrl}/{orgId}/collections/action-logs?actionId={actionId}` : ""),
  l3Action: process.env.DUAL_L3_ACTION_URL_TEMPLATE || process.env.DUAL_BLOCKSCOUT_ACTION_URL_TEMPLATE || (dualL3ExplorerBaseUrl ? `${dualL3ExplorerBaseUrl}/actions/{actionId}` : ""),
  l2Transaction: process.env.DUAL_L2_TX_URL_TEMPLATE || process.env.DUAL_BLOCKSCOUT_TX_URL_TEMPLATE || (dualL2ExplorerBaseUrl ? `${dualL2ExplorerBaseUrl}/tx/{transactionHash}` : ""),
  l1RollupTransaction: process.env.DUAL_L1_ROLLUP_TX_URL_TEMPLATE || (dualL1ExplorerBaseUrl ? `${dualL1ExplorerBaseUrl}/tx/{transactionHash}` : "")
};
const dualRecordLinkTemplates = {
  template: "/api/dual/records/templates/{templateId}",
  object: "/api/dual/records/objects/{objectId}",
  action: "/api/dual/records/actions/{actionId}",
  batch: "/api/dual/records/batches/{batchId}"
};
const supportedPairs = ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"];
const appVersion = "0.1.0";
const mcpProtocolVersion = "2025-06-18";
const mcpServerInfo = {
  name: "kraken-dual-agent-demo",
  version: appVersion
};
const tradePairSchema = { type: "string", enum: supportedPairs, default: "DUALUSD" };
const tradeSideSchema = { type: "string", enum: ["buy", "sell"], default: "buy" };
const tradeNotionalSchema = { type: "number", minimum: 1, default: 75 };
const proposalIdSchema = { type: "string", pattern: "^prop-" };
const mcpTools = [
  mcpTool("kraken_dual_get_status", "Read demo health, paper trading mode, DUAL readiness, proof status, and latest audit summary.", {
    type: "object",
    additionalProperties: false,
    properties: {
      include_proof: { type: "boolean", default: true },
      compact: { type: "boolean", default: false }
    }
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false } }),
  mcpTool("kraken_dual_get_market", "Read a Kraken market snapshot for an allowed paper-trading pair without placing an order.", {
    type: "object",
    additionalProperties: false,
    required: ["pair"],
    properties: {
      pair: tradePairSchema
    }
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false } }),
  mcpTool("kraken_dual_propose_trade", "Create a DUAL policy-checked paper trade proposal. When DUAL write config is ready, the proposal is anchored to DUAL.", {
    type: "object",
    additionalProperties: false,
    required: ["pair", "side", "notional_usd"],
    properties: {
      pair: tradePairSchema,
      side: tradeSideSchema,
      notional_usd: tradeNotionalSchema,
      approved: { type: "boolean", default: false }
    }
  }, { annotations: { readOnlyHint: false, destructiveHint: false }, "x-dual": { requiresWriteReadinessForAnchoring: true, localOnlyWithoutWriteReadiness: true } }),
  mcpTool("kraken_dual_approve_trade", "Record human approval for a waiting paper trade proposal. When DUAL write config is ready, the approval is anchored to DUAL.", {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: proposalIdSchema
    }
  }, { annotations: { readOnlyHint: false, destructiveHint: false }, "x-dual": { requiresWriteReadinessForAnchoring: true, localOnlyWithoutWriteReadiness: true } }),
  mcpTool("kraken_dual_execute_paper_trade", "Execute an existing approved proposal through the safe Kraken paper/simulator path. When DUAL receipt minting is configured, the receipt can be minted to DUAL.", {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: proposalIdSchema
    }
  }, { annotations: { readOnlyHint: false, destructiveHint: false }, "x-dual": { requiresWriteReadinessForAnchoring: true, localOnlyWithoutWriteReadiness: true } }),
  mcpTool("kraken_dual_propose_and_execute_paper_trade", "Create and execute a DUAL-approved paper trade in one call when policy allows it. When DUAL write config is ready, proposal/execution evidence is anchored to DUAL.", {
    type: "object",
    additionalProperties: false,
    required: ["pair", "side", "notional_usd"],
    properties: {
      pair: tradePairSchema,
      side: tradeSideSchema,
      notional_usd: tradeNotionalSchema
    }
  }, { annotations: { readOnlyHint: false, destructiveHint: false }, "x-dual": { requiresWriteReadinessForAnchoring: true, localOnlyWithoutWriteReadiness: true } }),
  mcpTool("kraken_dual_get_proof", "Read the portable DUAL x Kraken proof bundle.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false } }),
  mcpTool("kraken_dual_verify_proof", "Verify the current proof bundle and return validity, completeness, hashes, and checks.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false } }),
  mcpTool("kraken_dual_get_audit", "Read the latest local audit events and provenance hashes.", {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    }
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false } }),
  mcpTool("kraken_dual_get_replay_queue", "Read the DUAL event-bus replay queue. Public MCP does not execute replay writes.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false, writeExecutionExposed: false } }),
  mcpTool("kraken_dual_get_trade_receipts", "Read per-trade DUAL receipt status for executed paper trades. Public MCP does not mint receipts.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false, writeExecutionExposed: false } }),
  mcpTool("kraken_dual_get_transaction_history", "Read transaction history with paper-trade receipts, DUAL receipt objects, L3 actions, and L2/L1 batch links.", {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 12 }
    }
  }, { annotations: { readOnlyHint: true }, "x-dual": { requiresAuthentication: false, writeExecutionExposed: false } }),
  mcpTool("kraken_dual_red_team", "Red-team an existing or hypothetical paper trade proposal and prove unsafe requests are blocked before execution. Use proactively before approving edge-case trades.", {
    type: "object",
    additionalProperties: false,
    required: ["scenario"],
    properties: {
      scenario: { type: "string", enum: ["oversized", "blocked_pair", "leverage", "missing_approval"], default: "leverage" }
    }
  }, { annotations: { readOnlyHint: false, destructiveHint: false }, "x-dual": { requiresWriteReadinessForAnchoring: true, localOnlyWithoutWriteReadiness: true, proactiveUse: "Call before approving edge-case or high-risk trade requests." } })
];
const mcpResources = [
  mcpResource("kraken-dual://status", "Kraken DUAL status", "Health, policy, proof, and paper-execution status."),
  mcpResource("kraken-dual://proof", "Kraken DUAL proof", "Portable proof bundle for verifier readback."),
  mcpResource("kraken-dual://audit", "Kraken DUAL audit", "Latest audit events and provenance hashes."),
  mcpResource("kraken-dual://replay-queue", "Kraken DUAL replay queue", "Pending DUAL event-bus replay envelopes."),
  mcpResource("kraken-dual://trade-receipts", "Kraken DUAL trade receipts", "Per-trade DUAL receipt minting status."),
  mcpResource("kraken-dual://transaction-history", "Kraken DUAL transaction history", "Executed paper trades with DUAL receipt, L3 action, and L2/L1 settlement links.")
];
const mcpPrompts = [
  {
    name: "kraken_dual_demo_brief",
    description: "Summarize the DUAL-governed Kraken paper-trading demo for a partner or reviewer.",
    arguments: []
  },
  {
    name: "kraken_dual_next_action",
    description: "Inspect status and return the next concrete demo step.",
    arguments: []
  }
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      await handleMcp(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: "server_error",
      message: error.message,
      detail: error.body || null
    });
  }
});

server.listen(port, host, () => {
  console.log(`DUAL x Kraken demo running at http://${host}:${port}`);
});

async function handleApi(req, res, url) {
  restoreDualSession(req);

  if (req.method === "GET" && (url.pathname === "/api/openapi.json" || url.pathname === "/api/v1/openapi.json")) {
    sendJson(res, 200, buildOpenApiDocument(req), noCacheHeaders());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, await buildHealth(req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/status") {
    applyDualRuntimeConfig(await loadState());
    sendJson(res, 200, publicDualStatus(req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/write-readiness") {
    sendJson(res, 200, publicWriteReadiness(req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/auth/status") {
    sendJson(res, 200, publicDualAuthStatus(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/auth/request-code") {
    if (!emailCodeAuthEnabled) {
      sendJson(res, 403, emailAuthDisabled());
      return;
    }
    const body = await readBody(req);
    const result = await dualPersistence.requestEmailCode(body.email);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/auth/verify-code") {
    if (!emailCodeAuthEnabled) {
      sendJson(res, 403, emailAuthDisabled());
      return;
    }
    const body = await readBody(req);
    let sessionCookie = null;
    const result = await dualPersistence.verifyEmailCode(body.email, body.code, {
      onSession(session) {
        sessionCookie = createDualSessionCookie(session);
      }
    });
    sendJson(res, 200, result, sessionCookie ? { "set-cookie": sessionCookie } : {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/replay-queue") {
    const state = await loadState();
    applyDualRuntimeConfig(state);
    const durableObject = await safeReadPassportObject();
    sendJson(res, 200, publicReplayQueue(req, state.passport, state.audit || [], durableObject));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual/trade-receipts") {
    const state = await loadState();
    applyDualRuntimeConfig(state);
    sendJson(res, 200, publicTradeReceiptQueue(req, state.tradeReceipts || []));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/api/transactions/history" || url.pathname === "/api/dual/transaction-history")) {
    sendJson(res, 200, await publicTransactionHistory(req, {
      limit: url.searchParams.get("limit"),
      receiptId: url.searchParams.get("receiptId")
    }));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/dual/records/")) {
    const result = await readDualRecord(req, url.pathname);
    sendJson(res, result.available === false ? 404 : 200, result, noCacheHeaders());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/replay-queue/execute") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const state = await loadState();
    applyDualRuntimeConfig(state);
    const readiness = publicWriteReadiness(req);
    if (!readiness.ready) {
      sendJson(res, 409, {
        executed: false,
        error: "dual_write_not_ready",
        readiness,
        replayQueue: publicReplayQueue(req, state.passport, state.audit || [], await safeReadPassportObject())
      });
      return;
    }

    const result = await dualPersistence.executeReplayQueue(state.passport, state.audit || [], {
      durableObject: await safeReadPassportObject()
    });
    const syncedByEventId = new Map(result.events.map((event) => [event.eventId, event]));
    state.audit = (state.audit || []).map((event) => {
      const synced = syncedByEventId.get(event.id);
      if (!synced) return event;
      return {
        ...event,
        dualSync: {
          synced: true,
          envelopeHash: synced.envelopeHash,
          replayedAt: new Date().toISOString(),
          result: synced.result
        }
      };
    });
    await saveState(state);
    sendJson(res, 200, { executed: true, state, result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/trade-receipts/replay") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const state = await loadState();
    applyDualRuntimeConfig(state);
    const queue = publicTradeReceiptQueue(req, state.tradeReceipts || []);
    if (!queue.writable) {
      sendJson(res, 409, {
        executed: false,
        error: "dual_trade_receipt_minting_not_ready",
        tradeReceiptQueue: queue,
        detail: queue.ready
          ? "DUAL trade receipt replay needs authenticated write auth."
          : "Set DUAL_TRADE_RECEIPT_TEMPLATE_ID before replaying trade receipts."
      });
      return;
    }

    const result = await dualPersistence.executeTradeReceiptReplayQueue(state.tradeReceipts || []);
    const syncedByReceiptId = new Map(result.receipts.map((receipt) => [receipt.receiptId, receipt]));
    state.tradeReceipts = (state.tradeReceipts || []).map((receipt) => {
      const synced = syncedByReceiptId.get(receipt.id);
      if (!synced) return receipt;
      return {
        ...receipt,
        dualSync: {
          synced: true,
          envelopeHash: synced.envelopeHash,
          replayedAt: new Date().toISOString(),
          result: synced.result
        }
      };
    });
    state.proposals = (state.proposals || []).map((proposal) => {
      const receipt = (state.tradeReceipts || []).find((item) => item.proposalId === proposal.id);
      return receipt ? { ...proposal, tradeReceipt: summarizeTradeReceipt(receipt) } : proposal;
    });
    await saveState(state);
    sendJson(res, 200, { executed: true, state, result });
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
    const proof = await buildProofBundle(req);
    sendJson(res, 200, proof);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/proof/verify") {
    sendJson(res, 200, await buildProofVerification(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/template") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const result = await dualPersistence.createTemplate();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/action-passport/setup") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const body = await readBody(req);
    if (body.confirm !== "create-action-enabled-kraken-passport") {
      sendJson(res, 400, {
        error: "confirmation_required",
        message: "Send confirm=create-action-enabled-kraken-passport to create a persistent DUAL template and object."
      });
      return;
    }
    const state = await loadState();
    const result = await dualPersistence.createActionEnabledPassport(state.passport);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/trade-receipt-template/setup") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const body = await readBody(req);
    if (body.confirm !== "create-dual-trade-receipt-template") {
      sendJson(res, 400, {
        error: "confirmation_required",
        message: "Send confirm=create-dual-trade-receipt-template to create the DUAL trade receipt template."
      });
      return;
    }
    const result = await dualPersistence.createTradeReceiptTemplate();
    const state = await loadState();
    state.dualConfig = {
      ...(state.dualConfig || {}),
      tradeReceiptTemplateId: result.vercelEnv?.DUAL_TRADE_RECEIPT_TEMPLATE_ID || result.template?.id || null
    };
    applyDualRuntimeConfig(state);
    await saveState(state);
    sendJson(res, 200, { ...result, state });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/sync-passport") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const state = await loadState();
    applyDualRuntimeConfig(state);
    const result = await dualPersistence.syncPassport(state.passport, { source: "manual_sync" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dual/probe-update-schemas") {
    if (!canUseDualWrite(req)) {
      sendJson(res, 403, dualWriteForbidden(req));
      return;
    }
    const body = await readBody(req);
    if (body.confirm !== "probe-dual-update-schemas") {
      sendJson(res, 400, {
        error: "confirmation_required",
        message: "Send confirm=probe-dual-update-schemas to run sanitized DUAL update schema probes."
      });
      return;
    }
    const state = await loadState();
    applyDualRuntimeConfig(state);
    const result = await dualPersistence.probeUpdateSchemas(state.passport);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const state = await loadState();
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/policy") {
    const body = await readBody(req);
    const state = await loadState();
    applyDualRuntimeConfig(state);
    const previousPolicy = policySnapshot(state.passport);
    const policy = normalizePolicy(body, state.passport);
    const policyVersion = Number(state.passport.policyVersion || 1) + 1;

    state.passport = {
      ...state.passport,
      ...policy,
      policyVersion,
      dualObjectState: "active"
    };
    state.passport.policyHash = hashJson(policySnapshot(state.passport));

    state.proposals = (state.proposals || []).map((proposal) => {
      if (proposal.state === "executed") return proposal;
      const nextPolicy = evaluateTrade(state.passport, {
        ...proposal.trade,
        approved: proposal.approved
      });
      return {
        ...proposal,
        policy: nextPolicy,
        state: nextPolicy.decision === "block"
          ? "blocked"
          : nextPolicy.decision === "needs_approval"
            ? "awaiting_approval"
            : "approved",
        approved: proposal.approved || nextPolicy.decision === "allow"
      };
    });

    const event = await addAudit(req, state,
      "policy_updated",
      "ok",
      "Policy updated",
      `DUAL mandate now allows ${state.passport.allowedPairs.join(", ")} with ${formatUsd(state.passport.maxNotionalUsd)} per-trade cap.`,
      {
        previousPolicy,
        policy: policySnapshot(state.passport)
      }
    );
    await saveState(state);
    sendJson(res, 200, { state, policy: policySnapshot(state.passport), event });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const previous = await loadState();
    const state = await resetState();
    if (previous.dualConfig) {
      state.dualConfig = previous.dualConfig;
      applyDualRuntimeConfig(state);
      await saveState(state);
    }
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/market") {
    const pair = String(url.searchParams.get("pair") || "BTCUSD").toUpperCase();
    const { market } = await readMarketSnapshot(req, pair, { recordAudit: true });
    sendJson(res, 200, market);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/propose") {
    const body = await readBody(req);
    const { state, proposal } = await proposeTrade(req, body);
    sendJson(res, 200, { state, proposal });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approve") {
    const body = await readBody(req);
    const { state, proposal } = await approveTrade(req, body);
    sendJson(res, 200, { state, proposal });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execute-paper") {
    const body = await readBody(req);
    const result = await executePaperTradeProposal(req, body);
    sendJson(res, result.blocked ? 409 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/red-team") {
    const body = await readBody(req);
    sendJson(res, 200, await runRedTeam(req, body));
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function buildHealth(req) {
  applyDualRuntimeConfig(await loadState());
  const adapter = await getAdapterStatus();
  const dual = publicDualStatus(req);
  return {
    ok: true,
    app: {
      name: mcpServerInfo.name,
      version: appVersion,
      openapi: "/api/openapi.json",
      mcp: "/mcp"
    },
    safety: safetySummary(),
    features: publicFeatureStatus(),
    adapter,
    dual
  };
}

async function readMarketSnapshot(req, pair, { recordAudit = false } = {}) {
  const state = await loadState();
  applyDualRuntimeConfig(state);
  state.market = state.market || {};
  const market = await getMarket(pair, state.market);
  state.market[market.pair || pair] = {
    price: market.price,
    changePct: market.changePct,
    volume: market.volume,
    source: market.source
  };
  let event = null;
  if (recordAudit) {
    event = await addAudit(req, state,
      "market_snapshot",
      "ok",
      `${market.pair || pair} market snapshot`,
      `${describeMarketSource(market.source)} returned ${market.pair || pair} at $${market.price}.`,
      { pair: market.pair || pair, source: market.source, price: market.price }
    );
    await saveState(state);
  }
  return { state, market, event };
}

async function proposeTrade(req, input) {
  const state = await loadState();
  applyDualRuntimeConfig(state);
  state.market = state.market || {};
  state.proposals = state.proposals || [];
  const pair = String(input.pair || "BTCUSD").toUpperCase();
  const market = await getMarket(pair, state.market);
  state.market[pair] = {
    price: market.price,
    changePct: market.changePct,
    volume: market.volume,
    source: market.source
  };
  const trade = normalizeTrade({
    ...input,
    notional: input.notional ?? input.notional_usd ?? input.notionalUsd,
    price: market.price
  });
  const policy = evaluateTrade(state.passport, trade);
  const proposal = createProposal(trade, policy);
  state.proposals.unshift(proposal);
  state.passport.dualObjectState = proposal.state;
  const event = await addAudit(req, state,
    "trade_proposed",
    policy.decision === "block" ? "blocked" : "pending",
    policy.decision === "block" ? "Proposal blocked" : "Trade proposal created",
    describePolicy(trade, policy),
    { proposalId: proposal.id, trade, policy }
  );
  await saveState(state);
  return { state, proposal, market, event };
}

async function approveTrade(req, input) {
  const state = await loadState();
  applyDualRuntimeConfig(state);
  const id = requireProposalId(input);
  const proposal = (state.proposals || []).find((item) => item.id === id);
  if (!proposal) throw httpError("Proposal not found.", 404, "proposal_not_found");

  proposal.approved = true;
  proposal.state = "approved";
  proposal.trade.approved = true;
  proposal.policy = evaluateTrade(state.passport, proposal.trade);
  state.passport.dualObjectState = "approved";
  const event = await addAudit(req, state,
    "human_approved",
    "ok",
    "Human approval recorded",
    `${proposal.trade.side.toUpperCase()} ${proposal.trade.quantity} ${proposal.trade.pair} approved under DUAL mandate.`,
    { proposalId: proposal.id }
  );
  await saveState(state);
  return { state, proposal, event };
}

async function executePaperTradeProposal(req, input) {
  const state = await loadState();
  applyDualRuntimeConfig(state);
  const id = requireProposalId(input);
  const proposal = (state.proposals || []).find((item) => item.id === id);
  if (!proposal) throw httpError("Proposal not found.", 404, "proposal_not_found");

  const policy = evaluateTrade(state.passport, { ...proposal.trade, approved: proposal.approved });
  proposal.policy = policy;

  if (policy.decision !== "allow") {
    proposal.state = policy.decision === "needs_approval" ? "awaiting_approval" : policy.decision;
    state.passport.dualObjectState = policy.decision === "needs_approval" ? "awaiting_approval" : "blocked";
    await addAudit(req, state,
      "execution_blocked",
      "blocked",
      "Execution blocked by DUAL",
      describePolicy(proposal.trade, policy),
      { proposalId: proposal.id, policy }
    );
    await saveState(state);
    return { executed: false, blocked: true, state, proposal, policy };
  }

  const result = await executePaperTrade(proposal.trade);
  proposal.result = result;
  proposal.state = "executed";
  proposal.executedAt = new Date().toISOString();
  state.passport.dailyNotionalUsed = Math.round((state.passport.dailyNotionalUsed + policy.notional) * 100) / 100;
  state.passport.dualObjectState = "executed";
  const event = await addAudit(req, state,
    "paper_executed",
    "ok",
    "Kraken paper trade executed",
    `${proposal.trade.side.toUpperCase()} ${proposal.trade.quantity} ${proposal.trade.pair} via ${result.source}.`,
    {
      proposalId: proposal.id,
      trade: proposal.trade,
      policy,
      resultDigest: result.digest,
      source: result.source
    }
  );
  const receipt = createTradeReceipt(state.passport, proposal, event, result);
  receipt.dualSync = await syncTradeReceipt(req, receipt);
  state.tradeReceipts = state.tradeReceipts || [];
  state.tradeReceipts.unshift(receipt);
  proposal.tradeReceipt = summarizeTradeReceipt(receipt);
  await saveState(state);
  return { executed: true, blocked: false, state, proposal, result, tradeReceipt: summarizeTradeReceipt(receipt) };
}

async function syncTradeReceipt(req, receipt) {
  if (!canUseDualWrite(req)) {
    return {
      synced: false,
      reason: "DUAL trade receipt minting is disabled for this demo deployment."
    };
  }
  try {
    const dualResult = await dualPersistence.recordTradeReceipt(receipt);
    return dualResult?.skipped
      ? { synced: false, reason: dualResult.reason, replay: dualResult.replay || null }
      : { synced: true, envelopeHash: dualResult?.envelopeHash || null, result: dualResult?.result || null };
  } catch (error) {
    return { synced: false, error: error.message };
  }
}

async function proposeAndExecutePaperTrade(req, args) {
  const proposed = await proposeTrade(req, normalizeMcpTradeInput(args));
  if (proposed.proposal.policy.decision !== "allow") {
    return {
      ok: true,
      executed: false,
      status: proposed.proposal.policy.decision === "needs_approval" ? "requires_approval" : "blocked",
      proposal: proposed.proposal,
      market: proposed.market,
      writeState: publicWriteReadiness(req),
      warnings: agentWarnings(req, proposed.state),
      summary: summarizeStateForAgent(proposed.state)
    };
  }
  const executed = await executePaperTradeProposal(req, { id: proposed.proposal.id });
  return {
    ok: true,
    status: "executed",
    proposal: executed.proposal,
    result: executed.result,
    tradeReceipt: executed.tradeReceipt,
    writeState: publicWriteReadiness(req),
    warnings: agentWarnings(req, executed.state),
    summary: summarizeStateForAgent(executed.state)
  };
}

async function runRedTeam(req, input) {
  const state = await loadState();
  applyDualRuntimeConfig(state);
  state.market = state.market || {};
  const trade = redTeamTrade(input.scenario, state.passport, state.market);
  const policy = evaluateTrade(state.passport, trade);
  const event = await addAudit(req, state,
    "red_team_check",
    policy.decision === "block" ? "blocked" : "warning",
    `${trade.label} tested`,
    describePolicy(trade, policy),
    { scenario: input.scenario, trade, policy }
  );
  state.passport.dualObjectState = policy.decision === "block" ? "blocked" : state.passport.dualObjectState;
  await saveState(state);
  return { state, trade, policy, event };
}

async function buildProofVerification(req) {
  const proof = await buildProofBundle(req);
  return verifyProofBundle(proof);
}

function verifyProofBundle(proof) {
  const validityChecks = proof.verification.filter((check) => check.requiredFor !== "completeness");
  const completenessChecks = proof.verification.filter((check) => check.requiredFor === "completeness");
  const ok = validityChecks.every((check) => check.ok);
  const complete = ok && completenessChecks.every((check) => check.ok);
  return {
    ok,
    complete,
    status: complete ? "complete" : ok ? "valid_with_pending_replay" : "failed",
    proofHash: proof.proofHash,
    auditRoot: proof.audit.rootHash,
    replayRoot: proof.replayQueue.rootHash,
    checks: proof.verification
  };
}

async function buildAgentStatus(req, args = {}) {
  const [state, adapter] = await Promise.all([loadState(), getAdapterStatus()]);
  const writeReadiness = publicWriteReadiness(req);
  const warnings = agentWarnings(req, state);
  if (args.compact === true) {
    const proof = args.include_proof === false ? null : await buildProofVerification(req);
    return {
      ok: true,
      compact: true,
      app: mcpServerInfo.name,
      version: appVersion,
      mcp: `${requestOrigin(req)}/mcp`,
      mode: state.passport.mode,
      passportState: state.passport.dualObjectState || state.passport.state,
      allowedPairs: state.passport.allowedPairs,
      dailyNotionalUsed: state.passport.dailyNotionalUsed,
      krakenMarketData: adapter.source,
      paperExecutionPath: adapter.krakenCliAvailable ? "kraken-cli-paper" : "simulator",
      canWriteNow: writeReadiness.canWriteNow,
      writeReason: writeReadiness.reason,
      writeDetail: writeReadiness.detail,
      demoWritesEnabled: writeReadiness.writeGate?.allowed === true,
      dualMode: writeReadiness.mode,
      dualObjectId: publicDualStatus(req).objectId || null,
      tradeReceiptTemplateId: publicDualStatus(req).tradeReceiptTemplateId || null,
      proposals: (state.proposals || []).length,
      tradeReceipts: (state.tradeReceipts || []).length,
      auditEvents: (state.audit || []).length,
      warnings,
      proof: proof ? {
        ok: proof.ok,
        complete: proof.complete,
        status: proof.status,
        proofHash: proof.proofHash
      } : null
    };
  }
  const status = {
    ok: true,
    app: {
      name: mcpServerInfo.name,
      version: appVersion,
      openapi: `${requestOrigin(req)}/api/openapi.json`,
      mcp: `${requestOrigin(req)}/mcp`
    },
    safety: safetySummary(),
    adapter,
    dual: publicDualStatus(req),
    writeReadiness,
    warnings,
    summary: summarizeStateForAgent(state)
  };
  if (args.include_proof !== false) {
    status.proof = await buildProofVerification(req);
  }
  return status;
}

function agentWarnings(req, state = {}) {
  const warnings = [];
  const writeState = publicWriteReadiness(req);
  const replayQueue = state.passport ? publicReplayQueue(req, state.passport, state.audit || []) : null;
  const receiptQueue = publicTradeReceiptQueue(req, state.tradeReceipts || []);

  if (!writeState.canWriteNow) {
    warnings.push({
      code: "dual_anchoring_not_available",
      severity: "warning",
      message: "This MCP operation can run locally, but new DUAL action logs and receipt objects will not be created until DUAL write readiness is active.",
      reason: writeState.reason
    });
  }
  if (replayQueue?.pendingCount > 0) {
    warnings.push({
      code: "dual_replay_pending",
      severity: "warning",
      message: `${replayQueue.pendingCount}/${replayQueue.eventCount} DUAL event-bus envelopes are pending replay.`,
      pendingCount: replayQueue.pendingCount,
      eventCount: replayQueue.eventCount
    });
  }
  if (receiptQueue.pendingCount > 0) {
    warnings.push({
      code: "dual_receipts_pending",
      severity: "warning",
      message: `${receiptQueue.pendingCount}/${receiptQueue.receiptCount} trade receipts are local-only until DUAL receipt minting runs.`,
      pendingCount: receiptQueue.pendingCount,
      receiptCount: receiptQueue.receiptCount
    });
  }
  return warnings;
}

function summarizeStateForAgent(state, limit = 5) {
  const proposals = (state.proposals || []).slice(0, limit).map((proposal) => ({
    id: proposal.id,
    state: proposal.state,
    pair: proposal.trade?.pair,
    side: proposal.trade?.side,
    quantity: proposal.trade?.quantity,
    price: proposal.trade?.price,
    notional: proposal.policy?.notional,
    decision: proposal.policy?.decision,
    approved: proposal.approved,
    executedAt: proposal.executedAt,
    resultDigest: proposal.result?.digest || null,
    tradeReceipt: proposal.tradeReceipt || null
  }));
  const audit = (state.audit || []).slice(0, limit).map((event) => ({
    id: event.id,
    type: event.type,
    status: event.status,
    title: event.title,
    hash: event.provenanceHash || event.id,
    dualSync: event.dualSync || null,
    timestamp: event.timestamp
  }));
  return {
    passport: {
      id: state.passport.id,
      agentName: state.passport.agentName,
      mode: state.passport.mode,
      state: state.passport.dualObjectState || state.passport.state,
      allowedPairs: state.passport.allowedPairs,
      dailyNotionalUsed: state.passport.dailyNotionalUsed
    },
    policy: policySnapshot(state.passport),
    proposals,
    tradeReceipts: {
      receiptCount: (state.tradeReceipts || []).length,
      latest: (state.tradeReceipts || []).slice(0, limit).map(summarizeTradeReceipt)
    },
    audit: {
      eventCount: (state.audit || []).length,
      latest: audit
    }
  };
}

function safetySummary() {
  return {
    tradingMode: "paper",
    liveKrakenTradingExposed: false,
    krakenApiKeysRequired: false,
    dualWrites: publicDualWrites ? "public_enabled_by_env" : "disabled_by_env",
    exposedMcpDualWriteTools: false,
    supportedPairs
  };
}

async function handleMcp(req, res) {
  let requestId = null;
  try {
    restoreDualSession(req);
    assertMcpOrigin(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...securityHeaders(),
        ...mcpCorsHeaders(req),
        ...mcpVersionHeaders(),
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id"
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      return sendMcpResponse(req, res, mcpError(null, -32600, "MCP endpoint accepts POST requests."), 405);
    }
    const message = await readMcpMessage(req);
    requestId = message?.id ?? null;
    if (!message || message.jsonrpc !== "2.0" || !message.method) {
      return sendMcpResponse(req, res, mcpError(requestId, -32600, "Invalid JSON-RPC request."));
    }
    if (message.id === undefined && message.method.startsWith("notifications/")) {
      res.writeHead(202, { ...securityHeaders(), ...mcpCorsHeaders(req), ...mcpVersionHeaders() });
      res.end();
      return;
    }
    const result = await handleMcpMethod(req, message.method, message.params || {});
    return sendMcpResponse(req, res, mcpResult(message.id, result));
  } catch (error) {
    return sendMcpResponse(req, res, mcpError(requestId, mcpJsonRpcErrorCode(error), error.message || "MCP server error.", {
      code: error.code || "mcp_error",
      detail: error.detail || null
    }), error.status && error.status >= 400 ? error.status : 200);
  }
}

async function handleMcpMethod(req, method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: mcpProtocolVersion,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      },
      serverInfo: mcpServerInfo,
      auth: {
        required: false,
        type: "none",
        scope: "demo_dual_anchor",
        detail: "No MCP authentication is required. This public demo writes paper-trade evidence to DUAL when server-side DUAL API-key write config is ready."
      },
      instructions: "Use the Kraken DUAL tools for paper trades only. DUAL governs approvals and audit proof; public MCP does not expose real Kraken orders. DUAL anchoring runs when server-side DUAL API-key write config is ready."
    };
  }
  if (method === "tools/list") return { tools: mcpTools };
  if (method === "resources/list") return { resources: mcpResources };
  if (method === "prompts/list") return { prompts: mcpPrompts };
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    try {
      return mcpJsonContent(await callMcpTool(req, name, args));
    } catch (error) {
      return mcpToolErrorContent(error, name, args);
    }
  }
  if (method === "resources/read") {
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: "application/json",
          text: JSON.stringify(await readMcpResource(req, params.uri), null, 2)
        }
      ]
    };
  }
  if (method === "prompts/get") return getMcpPrompt(params.name, params.arguments || {});
  throw Object.assign(new Error(`Unsupported MCP method: ${method}`), { code: "mcp_method_not_found" });
}

async function callMcpTool(req, name, args) {
  switch (name) {
    case "kraken_dual_get_status":
      return buildAgentStatus(req, args);
    case "kraken_dual_get_market": {
      const { market } = await readMarketSnapshot(req, requireSupportedPair(args.pair), { recordAudit: false });
      return { ok: true, market, safety: safetySummary() };
    }
    case "kraken_dual_propose_trade": {
      const result = await proposeTrade(req, normalizeMcpTradeInput(args));
      return {
        ok: true,
        status: result.proposal.state,
        proposal: result.proposal,
        market: result.market,
        writeState: publicWriteReadiness(req),
        warnings: agentWarnings(req, result.state),
        summary: summarizeStateForAgent(result.state)
      };
    }
    case "kraken_dual_approve_trade": {
      const result = await approveTrade(req, { id: requireProposalId(args) });
      return {
        ok: true,
        status: result.proposal.state,
        proposal: result.proposal,
        writeState: publicWriteReadiness(req),
        warnings: agentWarnings(req, result.state),
        summary: summarizeStateForAgent(result.state)
      };
    }
    case "kraken_dual_execute_paper_trade": {
      const result = await executePaperTradeProposal(req, { id: requireProposalId(args) });
      return {
        ok: true,
        status: result.blocked ? "blocked" : "executed",
        executed: result.executed,
        proposal: result.proposal,
        policy: result.policy || result.proposal.policy,
        result: result.result || null,
        tradeReceipt: result.tradeReceipt || null,
        writeState: publicWriteReadiness(req),
        warnings: agentWarnings(req, result.state),
        summary: summarizeStateForAgent(result.state)
      };
    }
    case "kraken_dual_propose_and_execute_paper_trade":
      return proposeAndExecutePaperTrade(req, args);
    case "kraken_dual_get_proof":
      return { ok: true, proof: await buildProofBundle(req) };
    case "kraken_dual_verify_proof":
      return { ok: true, verification: await buildProofVerification(req) };
    case "kraken_dual_get_audit":
      return readAuditForAgent(args);
    case "kraken_dual_get_replay_queue": {
      const state = await loadState();
      return { ok: true, replayQueue: publicReplayQueue(req, state.passport, state.audit || [], await safeReadPassportObject()) };
    }
    case "kraken_dual_get_trade_receipts": {
      const state = await loadState();
      return { ok: true, tradeReceiptQueue: publicTradeReceiptQueue(req, state.tradeReceipts || []) };
    }
    case "kraken_dual_get_transaction_history":
      return { ok: true, transactionHistory: await publicTransactionHistory(req, args) };
    case "kraken_dual_red_team": {
      const result = await runRedTeam(req, { scenario: args.scenario || "leverage" });
      return {
        ok: true,
        scenario: args.scenario || "leverage",
        trade: result.trade,
        policy: result.policy,
        event: result.event,
        writeState: publicWriteReadiness(req),
        warnings: agentWarnings(req, result.state),
        summary: summarizeStateForAgent(result.state)
      };
    }
    default:
      throw Object.assign(new Error(`Unknown Kraken DUAL MCP tool: ${name}`), { code: "mcp_tool_not_found", status: 404 });
  }
}

async function readMcpResource(req, uri) {
  if (uri === "kraken-dual://status") return buildAgentStatus(req);
  if (uri === "kraken-dual://proof") return buildProofBundle(req);
  if (uri === "kraken-dual://audit") return readAuditForAgent({ limit: 20 });
  if (uri === "kraken-dual://replay-queue") {
    const state = await loadState();
    return { ok: true, replayQueue: publicReplayQueue(req, state.passport, state.audit || [], await safeReadPassportObject()) };
  }
  if (uri === "kraken-dual://trade-receipts") {
    const state = await loadState();
    return { ok: true, tradeReceiptQueue: publicTradeReceiptQueue(req, state.tradeReceipts || []) };
  }
  if (uri === "kraken-dual://transaction-history") return { ok: true, transactionHistory: await publicTransactionHistory(req, { limit: 20 }) };
  throw Object.assign(new Error(`Unknown Kraken DUAL MCP resource: ${uri}`), { code: "mcp_resource_not_found", status: 404 });
}

function getMcpPrompt(name, args) {
  if (name === "kraken_dual_demo_brief") {
    return {
      description: "Kraken DUAL demo brief",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Summarize the DUAL x Kraken paper-trading demo. Keep the distinction clear: Kraken supplies market/execution rails, DUAL supplies policy, approval, audit, proof, and live persistence when write readiness is active."
        }
      }]
    };
  }
  if (name === "kraken_dual_next_action") {
    return {
      description: "Kraken DUAL next action",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Inspect Kraken DUAL status and return the next concrete demo step. Target pair: ${args.pair || "DUALUSD"}. Keep public paper trading, DUAL write readiness, and proof completeness separate.`
        }
      }]
    };
  }
  throw Object.assign(new Error(`Unknown Kraken DUAL MCP prompt: ${name}`), { code: "mcp_prompt_not_found", status: 404 });
}

async function readAuditForAgent(args = {}) {
  const state = await loadState();
  const limit = clampInteger(args.limit, 1, 50, 10);
  return {
    ok: true,
    audit: {
      eventCount: (state.audit || []).length,
      latest: (state.audit || []).slice(0, limit).map((event) => ({
        id: event.id,
        type: event.type,
        status: event.status,
        title: event.title,
        detail: event.detail,
        hash: event.provenanceHash || event.id,
        dualSync: event.dualSync || null,
        timestamp: event.timestamp
      }))
    }
  };
}

function mcpTool(name, description, inputSchema, options = {}) {
  return { name, description, inputSchema, ...options };
}

function mcpResource(uri, name, description) {
  return { uri, name, description, mimeType: "application/json" };
}

async function readMcpMessage(req) {
  try {
    return await readBody(req);
  } catch {
    throw httpError("Request body must be valid JSON.", 400, "invalid_json");
  }
}

function sendMcpResponse(req, res, payload, status = 200) {
  res.writeHead(status, {
    ...securityHeaders(),
    ...mcpCorsHeaders(req),
    ...mcpVersionHeaders(),
    "content-type": "application/json; charset=utf-8",
    "mcp-session-id": mcpSessionId(req)
  });
  res.end(JSON.stringify(payload, null, 2));
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, code, message, data = null) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function mcpJsonContent(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function mcpToolErrorContent(error, name, args) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          tool_name: name || null,
          error: {
            code: error.code || "mcp_tool_failed",
            message: error.message || "Kraken DUAL MCP tool failed.",
            status: error.status || null,
            detail: error.detail || null
          },
          retryable: [408, 429, 500, 502, 503, 504].includes(Number(error.status)),
          arguments: redactMcpArguments(args)
        }, null, 2)
      }
    ]
  };
}

function assertMcpOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = (process.env.DEMO_MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowed.includes("*") || allowed.includes(origin)) return;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = "";
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (originHost && host && originHost === host) return;
  if (originHost.startsWith("127.0.0.1") || originHost.startsWith("localhost")) return;
  throw httpError("MCP origin is not allowed.", 403, "mcp_origin_denied");
}

function mcpCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "mcp-session-id, x-kraken-dual-version, x-mcp-protocol-version, x-mcp-schema-version",
    vary: "origin"
  };
}

function mcpVersionHeaders() {
  return {
    ...noCacheHeaders(),
    "x-kraken-dual-version": appVersion,
    "x-mcp-protocol-version": mcpProtocolVersion,
    "x-mcp-schema-version": `${appVersion}:${mcpTools.length}`
  };
}

function mcpJsonRpcErrorCode(error) {
  if (error.code === "mcp_method_not_found") return -32601;
  if (error.status === 400 || error.code === "argument_required") return -32602;
  return -32000;
}

function mcpSessionId(req) {
  const supplied = String(req.headers["mcp-session-id"] || "").trim();
  if (/^[a-zA-Z0-9._:-]{4,128}$/.test(supplied)) return supplied;
  const fingerprint = [
    req.headers["x-forwarded-host"] || req.headers.host || "",
    req.headers.origin || "",
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
    req.headers["user-agent"] || ""
  ].join("|");
  return `mcp-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 18)}`;
}

function redactMcpArguments(args = {}) {
  if (!args || typeof args !== "object") return {};
  const redacted = { ...args };
  for (const key of Object.keys(redacted)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) redacted[key] = "[REDACTED]";
  }
  return redacted;
}

function buildOpenApiDocument(req) {
  const origin = requestOrigin(req) || "http://localhost:4173";
  const jsonResponse = {
    description: "JSON response.",
    content: {
      "application/json": {
        schema: { type: "object", additionalProperties: true }
      }
    }
  };
  const requestBody = (schema) => ({
    required: true,
    content: { "application/json": { schema } }
  });
  const tradeRequestSchema = {
    type: "object",
    required: ["pair", "side", "notional"],
    additionalProperties: false,
    properties: {
      pair: tradePairSchema,
      side: tradeSideSchema,
      notional: tradeNotionalSchema,
      approved: { type: "boolean", default: false }
    }
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "DUAL x Kraken Agent Trading Passport API",
      version: appVersion,
    description: "Safe paper-trading API where Kraken supplies market/execution rails and DUAL supplies policy, approval, audit, proof, and live persistence when write readiness is active."
    },
    servers: [{ url: origin }],
    paths: {
      "/api/health": {
        get: { summary: "Read demo health and integration status.", responses: { 200: jsonResponse } }
      },
      "/api/openapi.json": {
        get: { summary: "Read this OpenAPI description.", responses: { 200: jsonResponse } }
      },
      "/api/dual/status": {
        get: { summary: "Read public DUAL adapter status and write gate state.", responses: { 200: jsonResponse } }
      },
      "/api/dual/write-readiness": {
        get: { summary: "Read whether DUAL writes are ready for this request.", responses: { 200: jsonResponse } }
      },
      "/api/dual/auth/status": {
        get: { summary: "Read scoped API-key and optional email-code auth status.", responses: { 200: jsonResponse } }
      },
      "/api/dual/auth/request-code": {
        post: {
          summary: "Request an optional DUAL email-code private browser session when DEMO_ENABLE_EMAIL_AUTH=true.",
          requestBody: requestBody({
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" } }
          }),
          responses: { 200: jsonResponse, 400: jsonResponse, 403: jsonResponse }
        }
      },
      "/api/dual/auth/verify-code": {
        post: {
          summary: "Verify an optional DUAL email-code private browser session when DEMO_ENABLE_EMAIL_AUTH=true.",
          requestBody: requestBody({
            type: "object",
            required: ["email", "code"],
            properties: {
              email: { type: "string", format: "email" },
              code: { type: "string" }
            }
          }),
          responses: { 200: jsonResponse, 400: jsonResponse, 403: jsonResponse }
        }
      },
      "/api/dual/replay-queue": {
        get: { summary: "Read DUAL event-bus replay envelopes.", responses: { 200: jsonResponse } }
      },
      "/api/dual/replay-queue/execute": {
        post: { summary: "Execute pending DUAL event-bus replay envelopes when public demo writes are enabled.", responses: { 200: jsonResponse, 403: jsonResponse, 409: jsonResponse } }
      },
      "/api/dual/trade-receipts": {
        get: { summary: "Read per-trade DUAL receipt minting status.", responses: { 200: jsonResponse } }
      },
      "/api/transactions/history": {
        get: { summary: "Read executed paper-trade transaction history with DUAL receipt, L3 action, and L2/L1 settlement links.", responses: { 200: jsonResponse } }
      },
      "/api/dual/transaction-history": {
        get: { summary: "Alias for DUAL-bound transaction history.", responses: { 200: jsonResponse } }
      },
      "/api/dual/records/templates/{templateId}": {
        get: { summary: "Read the explicit DUAL template record used by this proof bundle.", responses: { 200: jsonResponse, 404: jsonResponse } }
      },
      "/api/dual/records/objects/{objectId}": {
        get: { summary: "Read the explicit DUAL object record used by this proof bundle.", responses: { 200: jsonResponse, 404: jsonResponse } }
      },
      "/api/dual/records/actions/{actionId}": {
        get: { summary: "Read explicit DUAL action evidence from the latest proof batch or replay queue.", responses: { 200: jsonResponse, 404: jsonResponse } }
      },
      "/api/dual/records/batches/{batchId}": {
        get: { summary: "Read explicit DUAL batch evidence from the current proof bundle.", responses: { 200: jsonResponse, 404: jsonResponse } }
      },
      "/api/dual/trade-receipts/replay": {
        post: { summary: "Mint pending executed-trade receipts into DUAL when public demo writes are enabled.", responses: { 200: jsonResponse, 403: jsonResponse, 409: jsonResponse } }
      },
      "/api/dual/trade-receipt-template/setup": {
        post: {
          summary: "Create a DUAL trade receipt template when public demo writes are enabled.",
          requestBody: requestBody({
            type: "object",
            required: ["confirm"],
            properties: { confirm: { type: "string", const: "create-dual-trade-receipt-template" } }
          }),
          responses: { 200: jsonResponse, 400: jsonResponse, 403: jsonResponse }
        }
      },
      "/api/dual/action-passport/setup": {
        post: {
          summary: "Create an action-enabled DUAL agent passport template and passport object when public demo writes are enabled.",
          requestBody: requestBody({
            type: "object",
            required: ["confirm"],
            properties: { confirm: { type: "string", const: "create-action-enabled-kraken-passport" } }
          }),
          responses: { 200: jsonResponse, 400: jsonResponse, 403: jsonResponse }
        }
      },
      "/api/proof": {
        get: { summary: "Read portable proof bundle.", responses: { 200: jsonResponse } }
      },
      "/api/proof/verify": {
        get: { summary: "Verify current proof bundle.", responses: { 200: jsonResponse } }
      },
      "/api/state": {
        get: { summary: "Read local demo state.", responses: { 200: jsonResponse } }
      },
      "/api/market": {
        get: {
          summary: "Read market data for a supported pair.",
          parameters: [{
            name: "pair",
            in: "query",
            schema: tradePairSchema,
            required: false
          }],
          responses: { 200: jsonResponse }
        }
      },
      "/api/policy": {
        post: {
          summary: "Update the local DUAL trading policy.",
          requestBody: requestBody({
            type: "object",
            required: ["allowedPairs", "maxNotionalUsd", "maxDailyNotionalUsd", "humanApprovalRequiredAbove", "leverageAllowed"],
            properties: {
              allowedPairs: { type: "array", items: tradePairSchema },
              maxNotionalUsd: { type: "number", minimum: 1 },
              maxDailyNotionalUsd: { type: "number", minimum: 1 },
              humanApprovalRequiredAbove: { type: "number", minimum: 0 },
              leverageAllowed: { type: "boolean" }
            }
          }),
          responses: { 200: jsonResponse }
        }
      },
      "/api/propose": {
        post: {
          summary: "Create a DUAL policy-checked paper trade proposal.",
          requestBody: requestBody(tradeRequestSchema),
          responses: { 200: jsonResponse }
        }
      },
      "/api/approve": {
        post: {
          summary: "Approve a waiting paper trade proposal.",
          requestBody: requestBody({
            type: "object",
            required: ["id"],
            properties: { id: proposalIdSchema }
          }),
          responses: { 200: jsonResponse, 404: jsonResponse }
        }
      },
      "/api/execute-paper": {
        post: {
          summary: "Execute an approved proposal through paper/simulator rails.",
          requestBody: requestBody({
            type: "object",
            required: ["id"],
            properties: { id: proposalIdSchema }
          }),
          responses: { 200: jsonResponse, 409: jsonResponse, 404: jsonResponse }
        }
      },
      "/api/red-team": {
        post: {
          summary: "Run a safe policy-violation scenario.",
          requestBody: requestBody({
            type: "object",
            required: ["scenario"],
            properties: {
              scenario: { type: "string", enum: ["oversized", "blocked_pair", "leverage", "missing_approval"] }
            }
          }),
          responses: { 200: jsonResponse }
        }
      },
      "/mcp": {
        post: {
          summary: "MCP JSON-RPC facade for paper-trading tools, proof resources, and demo prompts.",
          requestBody: requestBody({
            type: "object",
            required: ["jsonrpc", "method"],
            properties: {
              jsonrpc: { type: "string", const: "2.0" },
              id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
              method: { type: "string" },
              params: { type: "object", additionalProperties: true }
            }
          }),
          responses: { 200: jsonResponse, 405: jsonResponse }
        },
        options: {
          summary: "MCP CORS preflight.",
          responses: { 204: { description: "No content." } }
        }
      }
    },
    components: {
      securitySchemes: {
      }
    },
    "x-mcp": {
      endpoint: `${origin}/mcp`,
      protocolVersion: mcpProtocolVersion,
      serverInfo: mcpServerInfo,
      tools: mcpTools.map((tool) => tool.name),
      toolMetadata: mcpTools.map((tool) => ({
        name: tool.name,
        annotations: tool.annotations || {},
        dual: tool["x-dual"] || {}
      })),
      resources: mcpResources.map((resource) => resource.uri),
      auth: {
        required: false,
        type: "none",
        scope: "demo_dual_anchor"
      }
    },
    "x-safety": safetySummary()
  };
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
    res.writeHead(200, { "content-type": contentType(filePath), ...noCacheHeaders() });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  if (!body) return {};
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  return JSON.parse(body);
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

function noCacheHeaders() {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    expires: "0"
  };
}

function requestOrigin(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || req.headers.host || "";
  if (!host) return "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req.socket?.encrypted ? "https" : "http");
  return `${proto}://${host}`;
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

function normalizeMcpTradeInput(args = {}) {
  return {
    pair: requireSupportedPair(args.pair),
    side: requireTradeSide(args.side),
    notional: parseMcpNotional(args.notional_usd),
    approved: Boolean(args.approved)
  };
}

function requireSupportedPair(value) {
  const pair = String(value || "DUALUSD").toUpperCase();
  if (!supportedPairs.includes(pair)) {
    throw httpError(`Unsupported pair ${pair}.`, 400, "unsupported_pair", { supportedPairs });
  }
  return pair;
}

function requireTradeSide(value) {
  const side = String(value || "buy").toLowerCase();
  if (!["buy", "sell"].includes(side)) {
    throw httpError("side must be buy or sell.", 400, "unsupported_side");
  }
  return side;
}

function parseMcpNotional(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError("notional_usd must be greater than zero.", 400, "invalid_notional");
  }
  return roundMoney(amount);
}

function requireProposalId(input = {}) {
  const id = String(input.proposal_id || input.id || "").trim();
  if (!id) throw httpError("proposal_id is required.", 400, "argument_required");
  return id;
}

function clampInteger(value, min, max, fallback) {
  const amount = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(amount)) return fallback;
  return Math.max(min, Math.min(max, amount));
}

function httpError(message, status = 400, code = "bad_request", detail = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
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

function normalizePolicy(input, currentPassport) {
  const allowedPairs = normalizeAllowedPairs(input.allowedPairs);
  const maxNotionalUsd = parsePositiveMoney(input.maxNotionalUsd, "Max trade");
  const maxDailyNotionalUsd = parsePositiveMoney(input.maxDailyNotionalUsd, "Daily cap");
  const humanApprovalRequiredAbove = parseNonNegativeMoney(input.humanApprovalRequiredAbove, "Approval threshold");
  const leverageAllowed = parseBoolean(input.leverageAllowed);

  if (maxDailyNotionalUsd < maxNotionalUsd) {
    const error = new Error("Daily cap must be at least the max trade amount.");
    error.status = 400;
    throw error;
  }

  const blockedActions = new Set(currentPassport.blockedActions || []);
  blockedActions.add("live_order");
  blockedActions.add("unsupported_pair");
  blockedActions.add("over_limit");
  blockedActions.add("missing_approval");
  if (leverageAllowed) {
    blockedActions.delete("leverage");
  } else {
    blockedActions.add("leverage");
  }

  return {
    allowedPairs,
    maxNotionalUsd,
    maxDailyNotionalUsd,
    humanApprovalRequiredAbove,
    leverageAllowed,
    blockedActions: [...blockedActions],
    approvalPolicy: "human_required_above_threshold"
  };
}

function normalizeAllowedPairs(input) {
  const supportedPairSet = new Set(supportedPairs);
  const values = Array.isArray(input)
    ? input
    : String(input || "").split(/[\s,]+/);
  const allowedPairs = [...new Set(values
    .map((pair) => String(pair || "").trim().toUpperCase())
    .filter((pair) => supportedPairSet.has(pair)))];
  if (!allowedPairs.length) {
    const error = new Error("Select at least one supported pair.");
    error.status = 400;
    throw error;
  }
  return allowedPairs;
}

function parsePositiveMoney(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(`${label} must be greater than zero.`);
    error.status = 400;
    throw error;
  }
  return roundMoney(amount);
}

function parseNonNegativeMoney(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error(`${label} must be zero or greater.`);
    error.status = 400;
    throw error;
  }
  return roundMoney(amount);
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function normalizeExternalBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

function policySnapshot(passport) {
  return {
    allowedPairs: passport.allowedPairs,
    maxNotionalUsd: passport.maxNotionalUsd,
    maxDailyNotionalUsd: passport.maxDailyNotionalUsd,
    leverageAllowed: passport.leverageAllowed,
    humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove,
    blockedActions: passport.blockedActions,
    approvalPolicy: passport.approvalPolicy,
    policyVersion: passport.policyVersion || 1
  };
}

function formatUsd(value) {
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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

function publicDualStatus(req) {
  const status = dualPersistence.status();
  const gate = dualWriteGate(req);
  const writeState = writeAvailability(req, dualPersistence.writeReadiness(), gate);
  if (!status.writable || gate.allowed) {
    const visibleStatus = { ...status, writeGate: gate, ...writeState };
    return { ...visibleStatus, links: buildDualDataLinks({ dualStatus: visibleStatus }) };
  }
  const visibleStatus = {
    ...status,
    serverWritable: true,
    writable: false,
    writeGate: gate,
    ...writeState,
    detail: gate.configured
      ? "DUAL is read-linked for this request. Public demo writes are disabled by configuration."
      : "DUAL is read-linked. Public demo writes are disabled by configuration."
  };
  return { ...visibleStatus, links: buildDualDataLinks({ dualStatus: visibleStatus }) };
}

function applyDualRuntimeConfig(state = {}) {
  if (typeof dualPersistence.configureRuntime !== "function") return;
  dualPersistence.configureRuntime({
    tradeReceiptTemplateId: state?.dualConfig?.tradeReceiptTemplateId
  });
}

function publicDualAuthStatus(req) {
  const auth = dualPersistence.authStatus();
  const gate = dualWriteGate(req);
  const writeState = writeAvailability(req, dualPersistence.writeReadiness(), gate);
  const emailDetail = emailCodeAuthEnabled
    ? "Email-code auth is enabled as an optional private fallback."
    : "Email-code auth is disabled by default; this demo uses scoped API-key auth for public demo DUAL writes.";
  return {
    ...auth,
    writeGate: gate,
    emailCodeAuthEnabled,
    emailCodeRequired: false,
    detail: auth.authenticated
      ? auth.detail
      : writeState.canWriteNow
        ? "Public demo DUAL writes are ready for this browser request."
      : gate.allowed
        ? "Public demo write gate is open; DUAL write readiness still needs server-side config."
      : emailCodeAuthEnabled
        ? auth.detail
        : emailDetail
  };
}

function emailAuthDisabled() {
  return {
    error: "email_auth_disabled",
    emailCodeAuthEnabled: false,
    emailCodeRequired: false,
    detail: "DUAL email-code auth is not required for this demo. The public demo uses scoped API-key auth for DUAL event-bus writes."
  };
}

function publicFeatureStatus() {
  return {
    emailCodeAuthEnabled,
    emailCodeRequired: false,
    dualConsoleLinksConfigured: Boolean(dualLinkTemplates.consoleTemplate || dualLinkTemplates.consoleObject || dualLinkTemplates.consoleAction),
    dualRecordLinksConfigured: true,
    dualL3ExplorerLinksConfigured: Boolean(dualLinkTemplates.l3Action),
    dualL2ExplorerLinksConfigured: Boolean(dualLinkTemplates.l2Transaction),
    dualL1RollupLinksConfigured: Boolean(dualLinkTemplates.l1RollupTransaction),
    dualBlockscoutLinksConfigured: Boolean(dualLinkTemplates.l2Transaction || dualLinkTemplates.l3Action)
  };
}

function publicWriteReadiness(req) {
  const readiness = dualPersistence.writeReadiness();
  const gate = dualWriteGate(req);
  const writeState = writeAvailability(req, readiness, gate);
  if (!readiness.ready || gate.allowed) {
    return { ...readiness, writeGate: gate, ...writeState };
  }
  return {
    ...readiness,
    ready: false,
    writeGate: gate,
    ...writeState,
    missing: [...new Set([...(readiness.missing || []), "public demo writes enabled"])],
    detail: "DUAL write sync is disabled because public demo writes are off."
  };
}

function writeAvailability(req, readiness = dualPersistence.writeReadiness(), gate = dualWriteGate(req)) {
  const persistenceReady = Boolean(readiness.ready);
  const canWriteNow = Boolean(persistenceReady && gate.allowed);
  const reason = canWriteNow
    ? "public_demo_writes_enabled"
    : !persistenceReady
      ? "dual_write_not_ready"
      : "public_demo_writes_disabled";
  return {
    canWriteNow,
    reason,
    persistenceReady,
    serverWritable: persistenceReady,
    demoWritesEnabled: gate.allowed,
    detail: canWriteNow
      ? "DUAL writes are ready for public demo requests."
      : !persistenceReady
        ? readiness.detail
        : "DUAL writes are configured server-side, but public demo writes are disabled."
  };
}

async function safeReadPassportObject() {
  try {
    return await dualPersistence.readPassportObject();
  } catch {
    return null;
  }
}

function publicReplayQueue(req, passport, audit, durableObject = null) {
  const queue = dualPersistence.buildReplayQueue(passport, audit, { durableObject });
  return {
    ...queue,
    writable: Boolean(queue.writable && publicWriteReadiness(req).ready)
  };
}

function publicTradeReceiptQueue(req, tradeReceipts = []) {
  const queue = dualPersistence.buildTradeReceiptQueue(tradeReceipts);
  return {
    ...queue,
    writable: Boolean(queue.writable && publicWriteReadiness(req).ready),
    latest: (tradeReceipts || []).slice(0, 8).map(summarizeTradeReceipt)
  };
}

async function publicTransactionHistory(req, args = {}) {
  const limit = clampInteger(args.limit, 1, 50, 12);
  const [state, proof] = await Promise.all([loadState(), buildProofBundle(req)]);
  applyDualRuntimeConfig(state);
  const receipts = state.tradeReceipts || [];
  const receiptId = String(args.receiptId || "").trim();
  const filteredReceipts = receiptId
    ? receipts.filter((receipt) => receipt.id === receiptId || receipt.proposalId === receiptId)
    : receipts;
  const receiptQueue = publicTradeReceiptQueue(req, receipts);
  const batch = proof.dualBatch?.available ? proof.dualBatch : null;
  const orgId = firstNonEmpty(proof.dualObject?.orgId, proof.status?.dualMode?.orgId, process.env.DUAL_ORG_ID);
  let transactions = filteredReceipts.slice(0, limit).map((receipt) => transactionHistoryItem(receipt, { proof, batch, orgId }));
  const policyBlocks = receiptId ? [] : policyBlockHistoryItems(state.audit || [], { orgId, limit: 4 });
  const latestBatch = batch ? {
    id: batch.id,
    status: batch.status,
    proofValue: batch.proofValue,
    finality: batch.finality,
    transactionHash: firstNonEmpty(batch.l2TransactionHash, batch.transactionHash),
    l1TransactionHash: firstNonEmpty(batch.l1TransactionHash, batch.rollupTransactionHash)
  } : null;
  if (!receiptId && !transactions.length) {
    transactions = await recoveredReceiptTransactionsFromDual({ proof, batch, orgId, limit });
    if (!transactions.length) {
      transactions = recoveredTransactionsFromProof({ proof, batch, orgId, limit });
    }
  }
  const effectiveCounts = transactionHistoryCounts(transactions, receiptQueue, receipts.length);

  return {
    schemaVersion: "dual-kraken-transaction-history.v1",
    generatedAt: new Date().toISOString(),
    transactionCount: effectiveCounts.transactionCount,
    receiptCount: receipts.length,
    filteredCount: filteredReceipts.length,
    mintedCount: effectiveCounts.mintedCount,
    pendingCount: effectiveCounts.pendingCount,
    proofHash: proof.proofHash,
    summary: transactionHistorySummary(transactions, {
      totalCount: effectiveCounts.transactionCount,
      mintedCount: effectiveCounts.mintedCount,
      pendingCount: effectiveCounts.pendingCount,
      proofHash: proof.proofHash,
      latestBatch,
      policyBlockCount: policyBlocks.length
    }),
    latestBatch,
    policyBlockCount: policyBlocks.length,
    policyBlocks,
    transactions
  };
}

function policyBlockHistoryItems(audit = [], { orgId = null, limit = 4 } = {}) {
  return audit
    .filter((event) => event?.type === "red_team_check" || event?.status === "blocked")
    .slice(0, limit)
    .map((event) => policyBlockHistoryItem(event, { orgId }));
}

function policyBlockHistoryItem(event = {}, { orgId = null } = {}) {
  const result = event.dualSync?.result || {};
  const actionId = firstNonEmpty(result.actionId, result.action_id, result.id);
  const actionHash = firstNonEmpty(result.hash, result.integrityHash, result.integrity_hash, event.provenanceHash);
  const actionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId });
  const actionConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleAction, { orgId, actionId }) : null;
  const actionL3Href = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId, actionHash });
  return {
    id: event.id,
    type: event.type,
    status: event.status,
    title: event.title,
    detail: event.detail,
    scenario: event.payload?.scenario || null,
    timestamp: event.timestamp,
    eventHash: event.provenanceHash || event.id,
    dual: {
      synced: Boolean(event.dualSync?.synced),
      envelopeHash: event.dualSync?.envelopeHash || event.dualSync?.replay?.envelopeHash || null,
      actionId,
      actionHash,
      reason: event.dualSync?.reason || null,
      error: event.dualSync?.error || null
    },
    links: [
      transactionHistoryLink("L3 action", actionL3Href || actionConsoleHref || actionRecordHref, actionL3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", actionId),
      transactionHistoryLink("Data", actionRecordHref, "dual-record", actionId)
    ].filter((link) => link?.href)
  };
}

function transactionHistoryCounts(transactions = [], receiptQueue = {}, localReceiptCount = 0) {
  if (localReceiptCount) {
    return {
      transactionCount: localReceiptCount,
      mintedCount: receiptQueue.syncedCount || 0,
      pendingCount: receiptQueue.pendingCount || 0
    };
  }
  return {
    transactionCount: transactions.length,
    mintedCount: transactions.filter((tx) => tx.dual?.synced).length,
    pendingCount: transactions.filter((tx) => !tx.dual?.synced).length
  };
}

function transactionHistorySummary(transactions = [], {
  totalCount = 0,
  mintedCount = 0,
  pendingCount = 0,
  proofHash = null,
  latestBatch = null
} = {}) {
  const latest = transactions[0] || null;
  const totalNotionalUsd = transactions.reduce((sum, tx) => sum + Number(tx.notionalUsd || 0), 0);
  const l3ActionCount = transactions.filter((tx) => tx.dual?.actionId).length;
  const receiptObjectCount = transactions.filter((tx) => tx.dual?.receiptObjectId).length;
  const recoveredCount = transactions.filter((tx) => tx.recoveredFrom).length;
  const recoveredProofCount = transactions.filter((tx) => tx.recoveredFrom === "dual-batch-readback").length;
  const recoveredTradeCount = transactions.filter((tx) => tx.recoveredFrom === "dual-receipt-object-readback").length;
  return {
    status: recoveredProofCount && recoveredProofCount === totalCount
      ? "recovered_dual_proof"
      : totalCount === 0
      ? "empty"
      : pendingCount > 0
        ? "pending_dual_mints"
        : "all_dual_minted",
    statusLabel: recoveredProofCount && recoveredProofCount === totalCount
      ? "Recovered from DUAL proof"
      : totalCount === 0
      ? "No trades"
      : pendingCount > 0
        ? `${pendingCount} pending DUAL mint`
        : "All trades minted to DUAL",
    totalCount,
    mintedCount,
    pendingCount,
    recoveredCount,
    recoveredProofCount,
    recoveredTradeCount,
    totalNotionalUsd,
    l3ActionCount,
    receiptObjectCount,
    latestReceiptId: latest?.id || null,
    latestProposalId: latest?.proposalId || null,
    latestReceiptObjectId: latest?.dual?.receiptObjectId || null,
    latestActionId: latest?.dual?.actionId || null,
    latestBatchId: latest?.settlement?.batchId || latestBatch?.id || null,
    latestL2TransactionHash: latest?.settlement?.transactionHash || latestBatch?.transactionHash || null,
    latestL1TransactionHash: latest?.settlement?.l1TransactionHash || latestBatch?.l1TransactionHash || null,
    proofHash
  };
}

function transactionHistoryItem(receipt = {}, { proof = {}, batch = null, orgId = null } = {}) {
  const summary = summarizeTradeReceipt(receipt);
  const dualResult = receipt.dualSync?.result || {};
  const affectedObject = dualResult.affectedObject || {};
  const receiptObjectId = firstNonEmpty(dualResult.id, affectedObject.id);
  const receiptTemplateId = firstNonEmpty(affectedObject.templateId, proof.tradeReceipts?.targetTemplateId);
  const actionId = firstNonEmpty(dualResult.actionId, affectedObject.actionId);
  const batchAction = actionId
    ? (batch?.affectedActions || []).find((action) => action?.id === actionId)
    : null;
  const actionHash = firstNonEmpty(batchAction?.hash, dualResult.hash, receipt.receiptHash);
  const l2TransactionHash = firstNonEmpty(batch?.l2TransactionHash, batch?.transactionHash);
  const l1RollupHash = firstNonEmpty(batch?.l1TransactionHash, batch?.rollupTransactionHash);
  const batchRecordHref = renderUrlTemplate(dualRecordLinkTemplates.batch, { batchId: batch?.id });
  const receiptObjectRecordHref = renderUrlTemplate(dualRecordLinkTemplates.object, { objectId: receiptObjectId });
  const actionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId });
  const receiptObjectConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleObject, { orgId, objectId: receiptObjectId }) : null;
  const actionConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleAction, { orgId, actionId }) : null;
  const actionL3Href = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId, actionHash });
  const l2BatchHref = renderUrlTemplate(dualLinkTemplates.l2Transaction, { transactionHash: l2TransactionHash });
  const l1RollupHref = renderUrlTemplate(dualLinkTemplates.l1RollupTransaction, { transactionHash: l1RollupHash }) || l2BatchHref;
  const l1RouteValue = l1RollupHash || l2TransactionHash;
  const l1RouteHref = l1RollupHash ? l1RollupHref : l2BatchHref;
  const receiptDataHref = receipt.id ? `/api/transactions/history?receiptId=${encodeURIComponent(receipt.id)}` : null;
  const synced = Boolean(receipt.dualSync?.synced);
  const links = [
    transactionHistoryLink("Receipt", receiptObjectConsoleHref || receiptObjectRecordHref, receiptObjectConsoleHref ? "console" : "dual-record", receiptObjectId),
    transactionHistoryLink("Data", receiptObjectRecordHref || receiptDataHref, "dual-record", receiptObjectId || receipt.id),
    transactionHistoryLink("L3 explorer", actionL3Href || actionConsoleHref || actionRecordHref, actionL3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", actionId),
    transactionHistoryLink("L2 explorer", l2BatchHref, "l2-explorer", l2TransactionHash),
    transactionHistoryLink("L1 roll-up", l1RouteHref, l1RollupHash ? "l1-rollup" : "l2-explorer", l1RouteValue),
    transactionHistoryLink("Batch data", batchRecordHref, "dual-record", batch?.id)
  ].filter(Boolean);
  const route = [
    transactionHistoryRouteStep("receipt", "Receipt object", receiptObjectId, receiptObjectConsoleHref || receiptObjectRecordHref, receiptObjectConsoleHref ? "console" : "dual-record"),
    transactionHistoryRouteStep("l3", "L3 action", actionId, actionL3Href || actionConsoleHref || actionRecordHref, actionL3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", { hash: actionHash }),
    transactionHistoryRouteStep("l2", "L2 batch tx", l2TransactionHash || batch?.id, l2BatchHref, l2BatchHref ? "l2-explorer" : null, { batchId: batch?.id }),
    transactionHistoryRouteStep("l1", "L1 roll-up", l1RouteValue, l1RouteHref, l1RollupHash ? "l1-rollup" : "l2-explorer", { batchId: batch?.id, status: l1RollupHash ? "roll-up tx" : "via L2" })
  ].filter(Boolean);

  return {
    ...summary,
    eventId: receipt.eventId || null,
    eventHash: receipt.eventHash || null,
    quantity: receipt.quantity ?? null,
    priceUsd: receipt.priceUsd ?? null,
    trade: transactionTradeDetails(receipt),
    status: synced ? "dual_minted" : "pending_dual_mint",
    statusLabel: synced ? "Minted to DUAL" : "Pending DUAL mint",
    dual: {
      synced,
      envelopeHash: receipt.dualSync?.envelopeHash || null,
      receiptObjectId,
      receiptTemplateId,
      actionId,
      actionHash,
      integrityHash: firstNonEmpty(affectedObject.integrityHash, dualResult.integrityHash),
      stateHash: firstNonEmpty(affectedObject.stateHash, dualResult.stateHash),
      stateChangeId: firstNonEmpty(affectedObject.stateChangeId, dualResult.stateChangeId),
      error: receipt.dualSync?.error || null,
      reason: receipt.dualSync?.reason || null
    },
    settlement: batch ? {
      batchId: batch.id,
      status: batch.status,
      proofValue: batch.proofValue,
      finality: batch.finality,
      transactionHash: l2TransactionHash,
      l1TransactionHash: l1RollupHash,
      actionInLatestBatch: Boolean(batchAction)
    } : null,
    route,
    links
  };
}

async function recoveredReceiptTransactionsFromDual({ proof = {}, batch = null, orgId = null, limit = 12 } = {}) {
  if (typeof dualPersistence.readTradeReceiptObjects !== "function") return [];
  let readback = null;
  try {
    readback = await dualPersistence.readTradeReceiptObjects({ limit });
  } catch {
    return [];
  }
  if (!readback?.available || !Array.isArray(readback.objects) || !readback.objects.length) return [];

  const actions = [...(batch?.affectedActions || [])].reverse();
  const mintAction = actions.find((action) => String(action?.name || "").toLowerCase() === "mint") || null;
  const proofAction = actions.find((action) => action?.id) || null;
  return readback.objects
    .map((object) => dualReceiptObjectTransaction(object, { proof, batch, orgId, action: mintAction, proofAction }))
    .filter(Boolean)
    .sort((left, right) => new Date(right.executedAt || 0) - new Date(left.executedAt || 0))
    .slice(0, limit);
}

function dualReceiptObjectTransaction(object = {}, { proof = {}, batch = null, orgId = null, action = null, proofAction = null } = {}) {
  const custom = object.custom || {};
  const receiptObjectId = object.id || null;
  const receiptTemplateId = object.templateId || proof.dualTradeReceiptTemplate?.id || proof.status?.dualMode?.tradeReceiptTemplateId || null;
  const receiptId = firstNonEmpty(custom.receipt_id, custom.receiptId, receiptObjectId ? `dual-object-${receiptObjectId}` : null);
  const directAction = action?.id ? action : null;
  const batchProofAction = directAction ? null : proofAction;
  const actionId = directAction?.id || batchProofAction?.id || null;
  const actionHash = directAction?.hash || batchProofAction?.hash || null;
  const actionScope = directAction ? "receipt" : batchProofAction ? "batch_proof" : null;
  const l2TransactionHash = firstNonEmpty(batch?.l2TransactionHash, batch?.transactionHash);
  const l1RollupHash = firstNonEmpty(batch?.l1TransactionHash, batch?.rollupTransactionHash);
  const receiptObjectRecordHref = renderUrlTemplate(dualRecordLinkTemplates.object, { objectId: receiptObjectId });
  const receiptObjectConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleObject, { orgId, objectId: receiptObjectId }) : null;
  const actionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId });
  const actionConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleAction, { orgId, actionId }) : null;
  const actionL3Href = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId, actionHash });
  const l2BatchHref = renderUrlTemplate(dualLinkTemplates.l2Transaction, { transactionHash: l2TransactionHash });
  const l1RollupHref = renderUrlTemplate(dualLinkTemplates.l1RollupTransaction, { transactionHash: l1RollupHash }) || l2BatchHref;
  const l1RouteValue = l1RollupHash || l2TransactionHash;
  const l1RouteHref = l1RollupHash ? l1RollupHref : l2BatchHref;
  const batchRecordHref = renderUrlTemplate(dualRecordLinkTemplates.batch, { batchId: batch?.id });
  const receipt = {
    id: receiptId,
    proposalId: firstNonEmpty(custom.proposal_id, custom.proposalId),
    pair: firstNonEmpty(custom.trade_pair, custom.tradePair, custom.pair),
    side: firstNonEmpty(custom.trade_side, custom.tradeSide, custom.side),
    quantity: numberOrNull(firstNonEmpty(custom.trade_quantity, custom.tradeQuantity, custom.quantity)),
    priceUsd: numberOrNull(firstNonEmpty(custom.trade_price_usd, custom.tradePriceUsd, custom.priceUsd)),
    notionalUsd: numberOrNull(firstNonEmpty(custom.notional_usd, custom.notionalUsd)),
    policyDecision: firstNonEmpty(custom.policy_decision, custom.policyDecision),
    policyVersion: numberOrNull(firstNonEmpty(custom.policy_version, custom.policyVersion)),
    policyHash: firstNonEmpty(custom.policy_hash, custom.policyHash),
    executionMode: firstNonEmpty(custom.execution_mode, custom.executionMode),
    executionSource: firstNonEmpty(custom.execution_source, custom.executionSource),
    executionDigest: firstNonEmpty(custom.execution_digest, custom.executionDigest),
    eventId: firstNonEmpty(custom.event_id, custom.eventId),
    eventHash: firstNonEmpty(custom.event_hash, custom.eventHash),
    receiptHash: firstNonEmpty(custom.receipt_hash, custom.receiptHash, object.integrityHash),
    status: firstNonEmpty(custom.status, "executed"),
    executedAt: firstNonEmpty(custom.executed_at, custom.executedAt, object.whenModified, proof.generatedAt)
  };
  const links = [
    transactionHistoryLink("Receipt", receiptObjectConsoleHref || receiptObjectRecordHref, receiptObjectConsoleHref ? "console" : "dual-record", receiptObjectId),
    transactionHistoryLink("Data", receiptObjectRecordHref, "dual-record", receiptObjectId),
    transactionHistoryLink(actionScope === "batch_proof" ? "L3 explorer" : "L3 explorer", actionL3Href || actionConsoleHref || actionRecordHref, actionL3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", actionId),
    transactionHistoryLink("L2 explorer", l2BatchHref, "l2-explorer", l2TransactionHash),
    transactionHistoryLink("L1 roll-up", l1RouteHref, l1RollupHash ? "l1-rollup" : "l2-explorer", l1RouteValue),
    transactionHistoryLink("Batch data", batchRecordHref, "dual-record", batch?.id)
  ].filter(Boolean);

  return {
    ...receipt,
    recoveredFrom: "dual-receipt-object-readback",
    recoveryDetail: "Recovered from DUAL receipt object readback because this serverless instance has no local receipt state.",
    trade: transactionTradeDetails(receipt),
    status: "dual_object_recovered",
    statusLabel: "Recovered DUAL receipt",
    dual: {
      synced: true,
      envelopeHash: null,
      receiptObjectId,
      receiptTemplateId,
      actionId,
      actionHash,
      actionScope,
      integrityHash: object.integrityHash || null,
      stateHash: object.stateHash || null,
      stateChangeId: batch?.id || null,
      error: null,
      reason: null
    },
    settlement: batch ? {
      batchId: batch.id,
      status: batch.status,
      proofValue: batch.proofValue,
      finality: batch.finality,
      transactionHash: l2TransactionHash,
      l1TransactionHash: l1RollupHash,
      actionInLatestBatch: Boolean(actionId),
      actionScope
    } : null,
    route: [
      transactionHistoryRouteStep("receipt", "Receipt object", receiptObjectId, receiptObjectConsoleHref || receiptObjectRecordHref, receiptObjectConsoleHref ? "console" : "dual-record"),
      transactionHistoryRouteStep("l3", "L3 action", actionId, actionL3Href || actionConsoleHref || actionRecordHref, actionL3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", { hash: actionHash }),
      transactionHistoryRouteStep("l2", "L2 batch tx", l2TransactionHash || batch?.id, l2BatchHref, l2BatchHref ? "l2-explorer" : null, { batchId: batch?.id }),
      transactionHistoryRouteStep("l1", "L1 roll-up", l1RouteValue, l1RouteHref, l1RollupHash ? "l1-rollup" : "l2-explorer", { batchId: batch?.id, status: l1RollupHash ? "roll-up tx" : "via L2" })
    ],
    links
  };
}

function recoveredTransactionsFromProof({ proof = {}, batch = null, orgId = null, limit = 12 } = {}) {
  if (!batch?.id) return [];
  const actions = [...(batch.affectedActions || [])].reverse();
  const mintAction = actions.find((action) => String(action?.name || "").toLowerCase() === "mint");
  const action = mintAction || actions.find((item) => item?.id) || null;
  if (!action && !batch.id) return [];
  const actionId = action?.id || null;
  const actionHash = action?.hash || null;
  const l2TransactionHash = firstNonEmpty(batch.l2TransactionHash, batch.transactionHash);
  const l1RollupHash = firstNonEmpty(batch.l1TransactionHash, batch.rollupTransactionHash);
  const l3Href = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId, actionHash });
  const actionConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleAction, { orgId, actionId }) : null;
  const actionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId });
  const l2Href = renderUrlTemplate(dualLinkTemplates.l2Transaction, { transactionHash: l2TransactionHash });
  const l1Href = renderUrlTemplate(dualLinkTemplates.l1RollupTransaction, { transactionHash: l1RollupHash }) || l2Href;
  const batchRecordHref = renderUrlTemplate(dualRecordLinkTemplates.batch, { batchId: batch.id });
  const l1RouteValue = l1RollupHash || l2TransactionHash;
  const l1RouteHref = l1RollupHash ? l1Href : l2Href;
  const links = [
    transactionHistoryLink("L3 action", l3Href || actionConsoleHref || actionRecordHref, l3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", actionId),
    transactionHistoryLink("L2 explorer", l2Href, "l2-explorer", l2TransactionHash),
    transactionHistoryLink("L1 roll-up", l1RouteHref, l1RollupHash ? "l1-rollup" : "l2-explorer", l1RouteValue),
    transactionHistoryLink("Data", batchRecordHref, "dual-record", batch.id)
  ].filter(Boolean);

  return [{
    id: `dual-batch-${batch.id}`,
    proposalId: null,
    pair: "DUAL proof",
    side: "settled",
    notionalUsd: null,
    quantity: null,
    priceUsd: null,
    executionDigest: proof.proofHash || batch.hash || null,
    receiptHash: batch.hash || proof.proofHash || null,
    executedAt: batch.updatedAt || batch.createdAt || proof.generatedAt || null,
    recoveredFrom: "dual-batch-readback",
    recoveryDetail: "Recovered from DUAL batch readback because this serverless instance has no local trade receipt state.",
    title: mintAction ? "DUAL receipt mint" : "Latest DUAL action",
    statusValue: batch.proofValue || batch.status || "proof",
    status: "dual_recovered",
    statusLabel: "Recovered DUAL proof",
    tradeDetailsAvailable: false,
    tradeDetailReason: "Trade economics are unavailable in batch-only proof recovery.",
    trade: transactionTradeDetails({
      executionSource: "dual-batch-readback",
      executionMode: "proof"
    }),
    dual: {
      synced: true,
      envelopeHash: null,
      receiptObjectId: null,
      receiptTemplateId: proof.dualTradeReceiptTemplate?.id || proof.status?.dualMode?.tradeReceiptTemplateId || null,
      actionId,
      actionHash,
      integrityHash: batch.integrityRoot || null,
      stateHash: batch.actionsHash || null,
      stateChangeId: batch.id,
      error: null,
      reason: null
    },
    settlement: {
      batchId: batch.id,
      status: batch.status,
      proofValue: batch.proofValue,
      finality: batch.finality,
      transactionHash: l2TransactionHash,
      l1TransactionHash: l1RollupHash,
      actionInLatestBatch: Boolean(actionId)
    },
    route: [
      transactionHistoryRouteStep("receipt", "Receipt object", null, null, "dual-record"),
      transactionHistoryRouteStep("l3", "L3 action", actionId, l3Href || actionConsoleHref || actionRecordHref, l3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record", { hash: actionHash }),
      transactionHistoryRouteStep("l2", "L2 batch tx", l2TransactionHash || batch.id, l2Href, l2Href ? "l2-explorer" : null, { batchId: batch.id }),
      transactionHistoryRouteStep("l1", "L1 roll-up", l1RouteValue, l1RouteHref, l1RollupHash ? "l1-rollup" : "l2-explorer", { batchId: batch.id, status: l1RollupHash ? "roll-up tx" : "via L2" })
    ],
    links
  }].slice(0, limit);
}

function transactionTradeDetails(receipt = {}) {
  const pair = receipt.pair || null;
  const side = receipt.side || null;
  const quantity = numberOrNull(receipt.quantity);
  const priceUsd = numberOrNull(receipt.priceUsd);
  const notionalUsd = numberOrNull(receipt.notionalUsd);
  return {
    available: Boolean(pair || side || quantity !== null || priceUsd !== null || notionalUsd !== null),
    pair,
    baseAsset: pair ? String(pair).replace(/USD$/i, "") : null,
    side,
    quantity,
    priceUsd,
    notionalUsd,
    executionSource: receipt.executionSource || null,
    executionMode: receipt.executionMode || null,
    policyDecision: receipt.policyDecision || null,
    policyVersion: receipt.policyVersion ?? null,
    policyHash: receipt.policyHash || null
  };
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function transactionHistoryRouteStep(layer, label, id, href, source, extra = {}) {
  const resolvedHref = href || null;
  return {
    layer,
    label,
    id: id || null,
    href: resolvedHref,
    source: resolvedHref ? source || null : null,
    ready: Boolean(id || resolvedHref),
    detail: shortIdForLink(id || resolvedHref),
    ...extra
  };
}

function transactionHistoryLink(label, href, source, detail = null) {
  if (!href) return null;
  return {
    label: normalizedTransactionLinkLabel(label, source),
    href,
    source,
    detail: shortIdForLink(detail || href)
  };
}

function normalizedTransactionLinkLabel(label, source) {
  const raw = String(label || "Link");
  const lower = raw.toLowerCase();
  const isL2Batch = lower.includes("l2/l1") || lower.includes("l2 batch") || lower === "block explorer";
  if (isL2Batch && source === "l2-explorer") return "L2 explorer";
  if (isL2Batch && source === "l1-rollup") return "L1 roll-up";
  if (lower.includes("l3")) return source === "l3-explorer" ? "L3 explorer" : raw;
  if (lower.includes("l1")) return "L1 roll-up";
  if (isL2Batch && source === "dual-record") return "Batch data";
  return raw;
}

async function readDualRecord(req, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  const recordType = segments[3];
  const id = segments.slice(4).join("/");
  if (!recordType || !id) {
    return {
      available: false,
      error: "missing_record_id",
      detail: "Use /api/dual/records/{templates|objects|actions|batches}/{id}."
    };
  }

  const proof = await buildProofBundle(req);
  const base = {
    schemaVersion: "dual-record-readback.v1",
    id,
    generatedAt: new Date().toISOString(),
    source: "kraken-dual-agent-demo"
  };

  if (recordType === "templates") {
    const template = [proof.dualTemplate, proof.dualTradeReceiptTemplate]
      .find((item) => item?.available && item.id === id);
    return template
      ? { ...base, recordType: "template", available: true, data: template }
      : missingDualRecord(base, "template", proof);
  }

  if (recordType === "objects") {
    const object = [proof.dualObject]
      .find((item) => item?.available && item.id === id);
    const receiptObject = findTradeReceiptRecordByObjectId(proof.tradeReceipts, id);
    return object
      ? { ...base, recordType: "object", available: true, data: object }
      : receiptObject
        ? {
            ...base,
            recordType: "object",
            available: true,
            data: {
              id,
              source: "trade_receipt_mint",
              receipt: receiptObject
            }
          }
      : missingDualRecord(base, "object", proof);
  }

  if (recordType === "batches") {
    const batch = proof.dualBatch?.available && proof.dualBatch.id === id ? proof.dualBatch : null;
    return batch
      ? { ...base, recordType: "batch", available: true, data: batch }
      : missingDualRecord(base, "batch", proof);
  }

  if (recordType === "actions") {
    const batchActions = proof.dualBatch?.affectedActions || [];
    const batchAction = batchActions.find((action) => action?.id === id);
    const replayAction = [
      ...(proof.replayQueue?.latest || []),
      ...(proof.replayQueue?.pending || [])
    ].find((event) => event?.actionId === id);
    const receiptAction = findTradeReceiptRecordByActionId(proof.tradeReceipts, id);
    if (batchAction || replayAction || receiptAction) {
      return {
        ...base,
        recordType: "action",
        available: true,
        data: {
          action: batchAction || {
            id,
            name: replayAction?.envelope?.actionName || replayAction?.eventType || receiptAction?.envelope?.actionName || "mint",
            hash: replayAction?.eventHash || replayAction?.envelopeHash || receiptAction?.receiptHash || receiptAction?.envelopeHash || null
          },
          batch: proof.dualBatch?.available ? {
            id: proof.dualBatch.id,
            status: proof.dualBatch.status,
            proofValue: proof.dualBatch.proofValue,
            finality: proof.dualBatch.finality,
            integrityRoot: proof.dualBatch.integrityRoot,
            ipfsUrl: proof.dualBatch.ipfsUrl
          } : null,
          replayEvent: replayAction || null,
          tradeReceipt: receiptAction || null
        }
      };
    }
    return missingDualRecord(base, "action", proof);
  }

  return {
    ...base,
    available: false,
    error: "unsupported_record_type",
    detail: "Supported record types are templates, objects, actions, and batches."
  };
}

function missingDualRecord(base, recordType, proof) {
  return {
    ...base,
    recordType,
    available: false,
    error: "record_not_in_current_proof",
    detail: "The requested DUAL record is not part of the current proof bundle.",
    currentProofHash: proof.proofHash,
    links: proof.links || []
  };
}

function findTradeReceiptRecordByObjectId(tradeReceipts = {}, id = "") {
  return tradeReceiptRecords(tradeReceipts).find((receipt) => firstNonEmpty(
    receipt?.objectId,
    receipt?.dualObjectId,
    receipt?.dualSync?.result?.id
  ) === id) || null;
}

function findTradeReceiptRecordByActionId(tradeReceipts = {}, id = "") {
  return tradeReceiptRecords(tradeReceipts).find((receipt) => firstNonEmpty(
    receipt?.actionId,
    receipt?.dualSync?.result?.actionId
  ) === id) || null;
}

function tradeReceiptRecords(tradeReceipts = {}) {
  const records = [
    ...(tradeReceipts?.latest || []),
    ...(tradeReceipts?.pending || [])
  ];
  const seen = new Set();
  return records.filter((record) => {
    const key = firstNonEmpty(record?.id, record?.receiptId, record?.receiptHash, record?.eventId);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildDualSettlementRoute({ dualBatch = null, replayQueue = null, tradeReceipts = null } = {}) {
  const preferredActionId = latestDualActionId(replayQueue, tradeReceipts);
  const affectedActions = dualBatch?.affectedActions || [];
  const latestAction = affectedActions.find((action) => action?.id === preferredActionId)
    || [...affectedActions].reverse().find((action) => action?.id)
    || null;
  const actionId = firstNonEmpty(preferredActionId, latestAction?.id);
  const actionWithHash = latestAction
    || [...affectedActions].reverse().find((action) => action?.hash)
    || null;
  const actionHash = firstNonEmpty(actionWithHash?.hash, latestDualActionHash(replayQueue, tradeReceipts));
  const l2TransactionHash = firstNonEmpty(dualBatch?.l2TransactionHash, dualBatch?.transactionHash);
  const l1RollupHash = firstNonEmpty(dualBatch?.l1TransactionHash, dualBatch?.rollupTransactionHash);
  const actionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId });
  const l3ActionHref = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId, actionHash });
  const l2BatchHref = renderUrlTemplate(dualLinkTemplates.l2Transaction, { transactionHash: l2TransactionHash });
  const l1RollupHref = renderUrlTemplate(dualLinkTemplates.l1RollupTransaction, { transactionHash: l1RollupHash });

  return {
    label: "Protocol/L3 -> DUAL Network/L2 -> Ethereum/L1",
    layers: [
      {
        id: "l3-action",
        label: "L3 action",
        detail: shortIdForLink(actionHash || actionId),
        status: actionHash ? "action hash" : actionId ? "action id" : "pending",
        href: l3ActionHref || actionRecordHref,
        source: l3ActionHref ? "l3-explorer" : actionRecordHref ? "dual-record" : null
      },
      {
        id: "l2-batch",
        label: "L2 batch",
        detail: shortIdForLink(l2TransactionHash || dualBatch?.id),
        status: l2TransactionHash ? "batch tx" : dualBatch?.available ? dualBatch.status || dualBatch.finality || "readback" : "pending",
        href: l2BatchHref,
        source: l2BatchHref ? "l2-explorer" : null
      },
      {
        id: "l1-rollup",
        label: "L1 roll-up",
        detail: shortIdForLink(l1RollupHash || l2TransactionHash || dualBatch?.finality),
        status: l1RollupHash ? "anchored" : l2TransactionHash ? "via L2" : dualBatch?.available ? dualBatch.finality || "pending tx" : "pending",
        href: l1RollupHref || l2BatchHref,
        source: l1RollupHref ? "l1-rollup" : l2BatchHref ? "l2-explorer" : null
      }
    ]
  };
}

function buildDualDataLinks({
  dualStatus = {},
  dualObject = null,
  dualTemplate = null,
  dualTradeReceiptTemplate = null,
  dualBatch = null,
  replayQueue = null,
  tradeReceipts = null
} = {}) {
  const orgId = firstNonEmpty(dualObject?.orgId, dualStatus?.orgId, process.env.DUAL_ORG_ID);
  const objectId = dualObject?.available ? dualObject?.id : null;
  const templateId = dualTemplate?.available ? dualTemplate?.id : null;
  const receiptTemplateId = dualTradeReceiptTemplate?.available ? dualTradeReceiptTemplate?.id : null;
  const l2TransactionHash = firstNonEmpty(dualBatch?.l2TransactionHash, dualBatch?.transactionHash);
  const l1RollupHash = firstNonEmpty(dualBatch?.l1TransactionHash, dualBatch?.rollupTransactionHash);
  const actionId = latestDualActionId(replayQueue, tradeReceipts);
  const receiptObjectId = latestTradeReceiptObjectId(tradeReceipts);
  const links = [];

  if (orgId) {
    const consoleHref = renderUrlTemplate(dualLinkTemplates.consoleOrg, { orgId });
    addDualEntityLink(links, {
      id: "console-dashboard",
      label: "DUAL Console",
      href: consoleHref,
      detail: "Open the org dashboard.",
      source: "console",
      targets: [
        dualLinkTarget("Console", consoleHref, "console")
      ]
    });
  } else if (dualConsoleBaseUrl && dualLinkTemplates.consoleOrg) {
    links.push({
      id: "console-root",
      label: "DUAL Console",
      href: dualConsoleBaseUrl,
      detail: "Sign in to select an org.",
      source: "console"
    });
  }

  addDualEntityDataLink(links, {
    id: "dual-record-template",
    label: "Passport template data",
    detail: shortIdForLink(templateId),
    consoleHref: orgId ? renderUrlTemplate(dualLinkTemplates.consoleTemplate, { orgId, templateId }) : null,
    recordHref: renderUrlTemplate(dualRecordLinkTemplates.template, { templateId })
  });
  addDualEntityDataLink(links, {
    id: "dual-record-object",
    label: "Passport object data",
    detail: shortIdForLink(objectId),
    consoleHref: orgId ? renderUrlTemplate(dualLinkTemplates.consoleObject, { orgId, objectId }) : null,
    recordHref: renderUrlTemplate(dualRecordLinkTemplates.object, { objectId })
  });
  addDualEntityDataLink(links, {
    id: "dual-record-receipt-template",
    label: "Receipt template data",
    detail: shortIdForLink(receiptTemplateId),
    consoleHref: orgId ? renderUrlTemplate(dualLinkTemplates.consoleTemplate, { orgId, templateId: receiptTemplateId }) : null,
    recordHref: renderUrlTemplate(dualRecordLinkTemplates.template, { templateId: receiptTemplateId })
  });
  addDualEntityDataLink(links, {
    id: "dual-record-receipt-object",
    label: "Receipt object data",
    detail: shortIdForLink(receiptObjectId),
    consoleHref: orgId ? renderUrlTemplate(dualLinkTemplates.consoleObject, { orgId, objectId: receiptObjectId }) : null,
    recordHref: renderUrlTemplate(dualRecordLinkTemplates.object, { objectId: receiptObjectId })
  });

  const batchRecordHref = renderUrlTemplate(dualRecordLinkTemplates.batch, { batchId: dualBatch?.id });
  const batchL2Href = renderUrlTemplate(dualLinkTemplates.l2Transaction, { transactionHash: l2TransactionHash });
  const rollupHref = renderUrlTemplate(dualLinkTemplates.l1RollupTransaction, { transactionHash: l1RollupHash }) || batchL2Href;
  const batchExplorerHref = batchL2Href || rollupHref;
  addDualEntityLink(links, {
    id: "dual-record-batch",
    label: batchExplorerHref ? "L2/L1 explorers" : "Batch data",
    href: batchExplorerHref || batchRecordHref,
    detail: shortIdForLink(l1RollupHash || l2TransactionHash || dualBatch?.id),
    source: batchL2Href ? "l2-explorer" : rollupHref ? "l1-rollup" : "dual-record",
    targets: [
      dualLinkTarget("L2", batchL2Href, "l2-explorer"),
      dualLinkTarget("L1 roll-up", rollupHref, rollupHref === batchL2Href ? "l2-explorer" : "l1-rollup"),
      dualLinkTarget("Data", batchRecordHref, "dual-record")
    ]
  });

  for (const action of dualBatch?.affectedActions || []) {
    const actionIdForLink = action.id || action.hash;
    const actionHash = firstNonEmpty(action.hash, action.transactionHash);
    const actionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId: action.id });
    const actionConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleAction, { orgId, actionId: action.id }) : null;
    const actionL3Href = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId: action.id, actionHash });
    addDualEntityLink(links, {
      id: `dual-record-action-${actionIdForLink}`,
      label: `L3 action ${shortIdForLink(action.id)}`,
      href: actionL3Href || actionConsoleHref || actionRecordHref,
      detail: actionHash ? shortIdForLink(actionHash) : action.name || "Action data",
      source: actionL3Href ? "l3-explorer" : actionConsoleHref ? "console" : "dual-record",
      targets: [
        dualLinkTarget("L3", actionL3Href, "l3-explorer"),
        dualLinkTarget("Console", actionConsoleHref, "console"),
        dualLinkTarget("Data", actionRecordHref, "dual-record")
      ]
    });
  }

  const latestAction = (dualBatch?.affectedActions || []).find((action) => action?.id === actionId)
    || [...(dualBatch?.affectedActions || [])].reverse().find((action) => action?.id);
  const latestActionId = firstNonEmpty(actionId, latestAction?.id);
  const latestActionHash = firstNonEmpty(latestAction?.hash, latestDualActionHash(replayQueue, tradeReceipts));
  const latestActionRecordHref = renderUrlTemplate(dualRecordLinkTemplates.action, { actionId: latestActionId });
  const latestActionConsoleHref = orgId ? renderUrlTemplate(dualLinkTemplates.consoleAction, { orgId, actionId: latestActionId }) : null;
  const latestActionL3Href = renderUrlTemplate(dualLinkTemplates.l3Action, { actionId: latestActionId, actionHash: latestActionHash });
  addDualEntityLink(links, {
    id: "dual-record-action",
    label: "Latest L3 action",
    href: latestActionL3Href || latestActionConsoleHref || latestActionRecordHref,
    detail: shortIdForLink(latestActionHash || latestActionId),
    source: latestActionL3Href ? "l3-explorer" : latestActionConsoleHref ? "console" : "dual-record",
    targets: [
      dualLinkTarget("L3", latestActionL3Href, "l3-explorer"),
      dualLinkTarget("Console", latestActionConsoleHref, "console"),
      dualLinkTarget("Data", latestActionRecordHref, "dual-record")
    ]
  });

  return links;
}

function addDualEntityDataLink(links, { id, label, detail, consoleHref = null, recordHref = null }) {
  addDualEntityLink(links, {
    id,
    label,
    href: consoleHref || recordHref,
    detail,
    source: consoleHref ? "console" : "dual-record",
    targets: [
      dualLinkTarget("Console", consoleHref, "console"),
      dualLinkTarget("Data", recordHref, "dual-record")
    ]
  });
}

function latestDualActionId(replayQueue = null, tradeReceipts = null) {
  return firstNonEmpty(
    replayQueue?.allEvents?.find((event) => event?.actionId)?.actionId,
    replayQueue?.latest?.find((event) => event?.actionId)?.actionId,
    replayQueue?.events?.find((event) => event?.actionId)?.actionId,
    tradeReceipts?.allReceipts?.find((receipt) => receipt?.actionId)?.actionId,
    tradeReceipts?.latest?.find((receipt) => receipt?.actionId)?.actionId,
    tradeReceipts?.receipts?.find((receipt) => receipt?.actionId)?.actionId
  );
}

function latestDualActionHash(replayQueue = null, tradeReceipts = null) {
  return firstNonEmpty(
    replayQueue?.allEvents?.find((event) => event?.actionId)?.dualSync?.result?.hash,
    replayQueue?.allEvents?.find((event) => event?.actionId)?.eventHash,
    replayQueue?.allEvents?.find((event) => event?.actionId)?.envelopeHash,
    replayQueue?.latest?.find((event) => event?.actionId)?.dualSync?.result?.hash,
    replayQueue?.latest?.find((event) => event?.actionId)?.eventHash,
    replayQueue?.latest?.find((event) => event?.actionId)?.envelopeHash,
    replayQueue?.events?.find((event) => event?.actionId)?.dualSync?.result?.hash,
    replayQueue?.events?.find((event) => event?.actionId)?.eventHash,
    replayQueue?.events?.find((event) => event?.actionId)?.envelopeHash,
    tradeReceipts?.allReceipts?.find((receipt) => receipt?.actionId)?.dualSync?.result?.hash,
    tradeReceipts?.allReceipts?.find((receipt) => receipt?.actionId)?.receiptHash,
    tradeReceipts?.latest?.find((receipt) => receipt?.actionId)?.dualSync?.result?.hash,
    tradeReceipts?.latest?.find((receipt) => receipt?.actionId)?.receiptHash,
    tradeReceipts?.receipts?.find((receipt) => receipt?.actionId)?.dualSync?.result?.hash,
    tradeReceipts?.receipts?.find((receipt) => receipt?.actionId)?.receiptHash
  );
}

function latestTradeReceiptObjectId(tradeReceipts = null) {
  return firstNonEmpty(
    tradeReceipts?.allReceipts?.find((receipt) => receipt?.objectId)?.objectId,
    tradeReceipts?.latest?.find((receipt) => receipt?.dualObjectId || receipt?.objectId)?.dualObjectId,
    tradeReceipts?.latest?.find((receipt) => receipt?.objectId)?.objectId,
    tradeReceipts?.receipts?.find((receipt) => receipt?.objectId)?.objectId
  );
}

function addDualEntityLink(links, { id, label, href, detail, source = null, targets = [] }) {
  if (!href) return;
  links.push({
    id,
    label,
    href,
    detail,
    source: source || "console",
    targets: compactDualTargets(targets)
  });
}

function dualLinkTarget(label, href, source) {
  return href ? { label, href, source } : null;
}

function compactDualTargets(targets = []) {
  const seen = new Set();
  return targets.filter(Boolean).filter((target) => {
    if (!target.href) return false;
    const key = `${target.label}:${target.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addDualLink(links, id, label, template, values, detail, source = null) {
  const href = renderUrlTemplate(template, values);
  if (!href) return;
  addDualEntityLink(links, {
    id,
    label,
    href,
    detail,
    source: source || (id.startsWith("blockscout") ? "blockscout" : "console")
  });
}

function renderUrlTemplate(template, values) {
  const raw = String(template || "").trim();
  if (!raw) return null;
  let missingValue = false;
  const rendered = raw.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values?.[key];
    if (value === undefined || value === null || value === "") {
      missingValue = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  if (missingValue || /\{[a-zA-Z0-9_]+\}/.test(rendered)) return null;
  if (rendered.startsWith("/")) return rendered;
  try {
    const url = new URL(rendered);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || null;
}

function shortIdForLink(value) {
  const text = String(value || "");
  return text.length > 14 ? `${text.slice(0, 7)}...${text.slice(-5)}` : text;
}

function canUseDualWrite(req) {
  const auth = dualPersistence.authStatus();
  return publicDualWrites || auth.authType === "email_session";
}

function dualWriteGate(req) {
  return {
    required: false,
    configured: true,
    allowed: canUseDualWrite(req),
    publicWritesEnabled: publicDualWrites,
    authHeader: null,
    detail: publicDualWrites
      ? "Public DUAL writes are enabled for this paper-trading demo."
      : "Set DEMO_PUBLIC_DUAL_WRITES=true to enable live DUAL writes for this demo."
  };
}

function dualWriteForbidden(req) {
  return {
    executed: false,
    error: "public_demo_writes_disabled",
    writeGate: dualWriteGate(req),
    detail: "DUAL writes are disabled for this demo deployment by DEMO_PUBLIC_DUAL_WRITES=false."
  };
}

async function buildProofBundle(req) {
  const [state, adapter] = await Promise.all([loadState(), getAdapterStatus()]);
  applyDualRuntimeConfig(state);
  let dualObject = null;
  let dualTemplate = null;
  let dualTradeReceiptTemplate = null;
  let dualBatch = null;
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
  try {
    dualTradeReceiptTemplate = await dualPersistence.readTradeReceiptTemplate();
  } catch (error) {
    dualTradeReceiptTemplate = { available: false, error: error.message };
  }
  try {
    dualBatch = await dualPersistence.readLatestBatchProof();
  } catch (error) {
    dualBatch = { available: false, error: error.message };
  }

  const audit = state.audit || [];
  const tradeReceipts = state.tradeReceipts || [];
  const replayQueue = publicReplayQueue(req, state.passport, audit, dualObject);
  const tradeReceiptQueue = publicTradeReceiptQueue(req, tradeReceipts);
  const dualStatus = publicDualStatus(req);
  const proofDualStatus = stripLinks(dualStatus);
  const writeReadiness = publicWriteReadiness(req);
  const templateFields = dualTemplate?.custom || {};
  const objectCustom = dualObject?.custom || {};
  const expectedPolicyHash = state.passport.policyHash || hashJson(policySnapshot(state.passport));
  const dualPolicyAuthoritative = Boolean(objectCustom.policy_version && objectCustom.policy_hash);
  const requiredMandateFields = [
    "passport_id",
    "agent_name",
    "mode",
    "state",
    "allowed_pairs",
    "max_notional_usd",
    "max_daily_notional_usd",
    "leverage_allowed",
    "approval_policy",
    "last_event_id"
  ];
  const templateHasMandateSchema = Boolean(
    dualTemplate?.available && requiredMandateFields.every((field) => Object.hasOwn(templateFields, field))
  );
  const objectMatchesPassport = Boolean(
    dualObject?.available
      && objectCustom.agent_name === state.passport.agentName
      && objectCustom.passport_id === state.passport.id
      && objectCustom.mode === state.passport.mode
      && (dualPolicyAuthoritative || (
        arraysEqualIgnoreOrder(objectCustom.allowed_pairs || [], state.passport.allowedPairs)
        && objectCustom.max_notional_usd === String(state.passport.maxNotionalUsd)
        && objectCustom.max_daily_notional_usd === String(state.passport.maxDailyNotionalUsd)
        && objectCustom.human_approval_required_above === String(state.passport.humanApprovalRequiredAbove)
        && objectCustom.leverage_allowed === String(state.passport.leverageAllowed)
        && objectCustom.approval_policy === state.passport.approvalPolicy
        && objectCustom.policy_version === String(state.passport.policyVersion || 1)
        && objectCustom.policy_hash === expectedPolicyHash
      ))
  );
  const durableDualWrite = Boolean(
    dualObject?.available
      && objectCustom.last_event_id
      && objectCustom.last_event_hash
      && (dualPolicyAuthoritative || objectCustom.policy_hash === expectedPolicyHash)
  );
  const syncedAuditEvents = audit.filter((event) => (
    event.dualSync?.synced && event.dualSync?.result?.actionId
  )).length;
  const auditRoot = hashJson(audit.map((event) => ({
    id: event.id,
    type: event.type,
    status: event.status,
    hash: event.provenanceHash || event.id,
    dualSync: event.dualSync || null
  })));

  const verification = [
    {
      id: "kraken-market-source",
      ok: adapter.source === "kraken-cli" || adapter.source === "kraken-public-api",
      detail: `Market source is ${adapter.source}.`
    },
    {
      id: "dual-read-link",
      ok: Boolean(dualObject?.available && dualObject.id === dualStatus.objectId),
      detail: dualObject?.available ? `DUAL object ${dualObject.id} is readable.` : "DUAL object is not readable."
    },
    {
      id: "dual-mandate-template",
      ok: templateHasMandateSchema,
      detail: dualTemplate?.available ? "DUAL template exposes the Kraken agent mandate schema." : "DUAL template is not readable."
    },
    {
      id: "dual-object-readback",
      ok: objectMatchesPassport,
      detail: dualObject?.available ? "DUAL object custom data matches the local passport mandate." : "DUAL object is not readable."
    },
    {
      id: "dual-event-bus-sync",
      ok: Boolean((audit.length && syncedAuditEvents === audit.length) || durableDualWrite),
      detail: syncedAuditEvents === audit.length
        ? `${syncedAuditEvents}/${audit.length} audit events have DUAL event-bus action ids.`
        : `DUAL object has durable event pointer ${objectCustom.last_event_id || "pending"}; ${syncedAuditEvents}/${audit.length} local audit events retain action ids.`
    },
    {
      id: "replay-queue",
      ok: Boolean(replayQueue.ready && replayQueue.rootHash),
      detail: replayQueue.writable
        ? `${replayQueue.pendingCount}/${replayQueue.eventCount} event-bus envelopes are pending with write auth active.`
        : `${replayQueue.pendingCount}/${replayQueue.eventCount} event-bus envelopes are pending until write auth is available.`
    },
    {
      id: "replay-complete",
      ok: Boolean(replayQueue.pendingCount === 0 || syncedAuditEvents === audit.length),
      requiredFor: "completeness",
      detail: replayQueue.pendingCount
        ? `${replayQueue.pendingCount}/${replayQueue.eventCount} event-bus envelopes still need replay.`
        : "No replay envelopes are pending."
    },
    {
      id: "dual-trade-receipts",
      ok: Boolean(tradeReceiptQueue.rootHash),
      detail: tradeReceiptQueue.receiptCount
        ? `${tradeReceiptQueue.syncedCount}/${tradeReceiptQueue.receiptCount} executed trade receipts are minted to DUAL.`
        : "No executed trade receipts are present in local demo state."
    },
    {
      id: "trade-receipts-complete",
      ok: Boolean(tradeReceiptQueue.pendingCount === 0),
      requiredFor: "completeness",
      detail: tradeReceiptQueue.pendingCount
        ? `${tradeReceiptQueue.pendingCount}/${tradeReceiptQueue.receiptCount} trade receipts still need DUAL minting.`
        : "No trade receipt mints are pending."
    },
    {
      id: "dual-batch-status",
      ok: Boolean(dualBatch?.available && dualBatch.finality !== "failed"),
      detail: dualBatch?.available
        ? `Latest DUAL batch ${dualBatch.id} is ${dualBatch.status || dualBatch.finality}; proof ${dualBatch.proofValue || "pending"}.`
        : "DUAL sequencer batch status is not readable."
    }
  ];
  const settlement = buildDualSettlementRoute({ dualBatch, replayQueue, tradeReceipts: tradeReceiptQueue });

  const payload = {
    schemaVersion: "dual-kraken-proof.v2",
    demo: "DUAL x Kraken Agent Trading Passport",
    status: {
      krakenMarketData: adapter.source,
      krakenPaperExecution: adapter.krakenCliAvailable ? "kraken-cli-paper" : "simulated-paper",
      dualMode: proofDualStatus,
      writeReadiness
    },
    dualTemplate,
    dualObject,
    dualTradeReceiptTemplate,
    dualBatch,
    settlement,
    replayQueue: {
      ready: replayQueue.ready,
      writable: replayQueue.writable,
      eventCount: replayQueue.eventCount,
      syncedCount: replayQueue.syncedCount,
      pendingCount: replayQueue.pendingCount,
      rootHash: replayQueue.rootHash,
      pendingRootHash: replayQueue.pendingRootHash,
      targetObjectId: replayQueue.targetObjectId,
      latest: replayQueue.allEvents.slice(0, 8),
      pending: replayQueue.events.slice(0, 8)
    },
    tradeReceipts: {
      ready: tradeReceiptQueue.ready,
      writable: tradeReceiptQueue.writable,
      receiptCount: tradeReceiptQueue.receiptCount,
      syncedCount: tradeReceiptQueue.syncedCount,
      pendingCount: tradeReceiptQueue.pendingCount,
      rootHash: tradeReceiptQueue.rootHash,
      pendingRootHash: tradeReceiptQueue.pendingRootHash,
      targetTemplateId: tradeReceiptQueue.targetTemplateId,
      latest: tradeReceipts.slice(0, 8).map(summarizeTradeReceipt),
      pending: tradeReceiptQueue.receipts.slice(0, 8)
    },
    passport: {
      id: state.passport.id,
      agentName: state.passport.agentName,
      mode: state.passport.mode,
      state: state.passport.dualObjectState || state.passport.state,
      allowedPairs: state.passport.allowedPairs
    },
    policy: {
      version: dualPolicyAuthoritative ? Number(objectCustom.policy_version) : state.passport.policyVersion || 1,
      hash: dualPolicyAuthoritative ? objectCustom.policy_hash : state.passport.policyHash || hashJson(policySnapshot(state.passport)),
      allowedPairs: dualPolicyAuthoritative ? objectCustom.allowed_pairs || [] : state.passport.allowedPairs,
      maxNotionalUsd: dualPolicyAuthoritative ? Number(objectCustom.max_notional_usd) : state.passport.maxNotionalUsd,
      maxDailyNotionalUsd: dualPolicyAuthoritative ? Number(objectCustom.max_daily_notional_usd) : state.passport.maxDailyNotionalUsd,
      leverageAllowed: dualPolicyAuthoritative ? objectCustom.leverage_allowed === "true" : state.passport.leverageAllowed,
      humanApprovalRequiredAbove: dualPolicyAuthoritative ? Number(objectCustom.human_approval_required_above) : state.passport.humanApprovalRequiredAbove
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
      writeReadiness.canWriteNow ? "DUAL event-bus writes are enabled for this demo request." : "DUAL is read-linked; event-bus writes need public demo writes and DUAL write readiness."
    ],
    verification
  };

  return {
    generatedAt: new Date().toISOString(),
    ...payload,
    links: buildDualDataLinks({
      dualStatus: proofDualStatus,
      dualObject,
      dualTemplate,
      dualTradeReceiptTemplate,
      dualBatch,
      replayQueue,
      tradeReceipts: tradeReceiptQueue
    }),
    proofHash: hashJson(payload)
  };
}

function stripLinks(value) {
  if (!value || typeof value !== "object") return value;
  const { links, ...rest } = value;
  return rest;
}

function describeMarketSource(source) {
  if (source === "kraken-cli") return "Kraken CLI";
  if (source === "kraken-public-api") return "Kraken public API";
  return "Simulator";
}

async function addAudit(req, state, type, status, title, detail, payload = {}) {
  const event = createAuditEvent(type, status, title, detail, payload);
  try {
    if (canUseDualWrite(req)) {
      const dualResult = await dualPersistence.recordEvent(state.passport, event);
      event.dualSync = dualResult?.skipped
        ? { synced: false, reason: dualResult.reason, replay: dualResult.replay || null }
        : { synced: true, envelopeHash: dualResult?.envelopeHash || null, result: dualResult?.result || null };
    } else {
      event.dualSync = {
        synced: false,
        reason: "DUAL write sync is disabled for this demo deployment."
      };
    }
  } catch (error) {
    event.dualSync = { synced: false, error: error.message };
  }
  state.audit.unshift(event);
  return event;
}

function hashJson(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function arraysEqualIgnoreOrder(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

function restoreDualSession(req) {
  dualPersistence.clearEmailSession?.();
  if (!emailCodeAuthEnabled) return;
  const sealed = readCookie(req.headers.cookie || "", dualSessionCookieName);
  if (!sealed) return;
  const session = unsealDualSession(sealed);
  if (session) dualPersistence.restoreEmailSession(session);
}

function createDualSessionCookie(session) {
  const sealed = sealDualSession({
    ...session,
    expiresAt: Date.now() + 60 * 60 * 1000
  });
  return `${dualSessionCookieName}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
}

function sealDualSession(session) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dualSessionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function unsealDualSession(sealed) {
  try {
    const [ivText, tagText, encryptedText] = String(sealed).split(".");
    if (!ivText || !tagText || !encryptedText) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", dualSessionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final()
    ]);
    const session = JSON.parse(decrypted.toString("utf8"));
    if (!session.expiresAt || Date.now() > Number(session.expiresAt)) return null;
    return session;
  } catch {
    return null;
  }
}

function dualSessionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.DUAL_SESSION_SECRET || process.env.DUAL_API_KEY || "kraken-dual-agent-demo-dev-session")
    .digest();
}

function readCookie(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;
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
