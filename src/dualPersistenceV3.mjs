import crypto from "node:crypto";
import {
  tradeReceiptMetadata,
  tradeReceiptProperties
} from "./tradeReceipts.mjs";

export async function createDualPersistence() {
  const mode = process.env.DUAL_PERSISTENCE_MODE || "local";
  const orgId = process.env.DUAL_ORG_ID || "";
  const templateId = process.env.DUAL_AGENT_PASSPORT_TEMPLATE_ID || "";
  const objectId = process.env.DUAL_AGENT_PASSPORT_OBJECT_ID || "";
  let tradeReceiptTemplateId = process.env.DUAL_TRADE_RECEIPT_TEMPLATE_ID || "";
  const baseUrl = process.env.DUAL_API_URL || "https://api-testnet.dual.network";
  const apiKey = process.env.DUAL_API_KEY || "";
  const authMode = normalizeAuthMode(process.env.DUAL_AUTH_MODE || "api_key");
  const writeMode = process.env.DUAL_WRITE_MODE || "read_only";
  const eventBusWritePath = normalizePath(process.env.DUAL_EVENTBUS_WRITE_PATH || "/ebus/execute");
  const serviceToken = process.env.DUAL_SERVICE_ACCOUNT_TOKEN
    || process.env.DUAL_SERVICE_ACCOUNT_BEARER_TOKEN
    || process.env.DUAL_BEARER_TOKEN
    || "";
  const serviceRefreshToken = process.env.DUAL_SERVICE_ACCOUNT_REFRESH_TOKEN || "";
  const serviceAuthMode = normalizeAuthMode(process.env.DUAL_SERVICE_ACCOUNT_AUTH_MODE || "api_key");

  let DualClient = null;
  let client = null;
  let serviceClient = null;
  let sessionClient = null;
  let session = null;
  let pendingEmail = null;
  let sdkError = null;

  if (mode === "dual") {
    try {
      ({ DualClient } = await import("dual-sdk"));
      if (apiKey) client = makeClient(apiKey, authMode);
      if (serviceToken) serviceClient = makeClient(serviceToken, serviceAuthMode);
      if (serviceRefreshToken) {
        const refreshed = makeClient("", "bearer");
        const tokens = await refreshed.sdk.wallets.refreshToken(serviceRefreshToken);
        refreshed.token = tokens.access_token;
        refreshed.sdk.setToken(tokens.access_token);
        try {
          const orgTokens = await refreshed.sdk.wallets.switchOrganization(orgId);
          refreshed.token = orgTokens.access_token;
          refreshed.sdk.setToken(orgTokens.access_token);
        } catch {
          // Some refresh tokens are already org scoped.
        }
        serviceClient = refreshed;
      }
    } catch (error) {
      sdkError = error;
    }
  }

  return {
    configureRuntime(config = {}) {
      if (config.tradeReceiptTemplateId) tradeReceiptTemplateId = String(config.tradeReceiptTemplateId);
      return { tradeReceiptTemplateId: tradeReceiptTemplateId || null };
    },

    status() {
      const read = activeReadClient();
      const write = activeWriteClient();
      if (mode !== "dual") {
        return { mode: "local", configured: false, available: true, writable: false, detail: "Using local DUAL passport simulator." };
      }
      return {
        mode: "dual",
        configured: Boolean((apiKey || serviceToken || serviceRefreshToken || sessionClient) && orgId && templateId),
        available: Boolean(read),
        writable: Boolean(write),
        orgId: orgId || null,
        templateId: templateId || null,
        objectId: objectId || null,
        tradeReceiptTemplateId: tradeReceiptTemplateId || null,
        tradeReceipts: {
          configured: Boolean(tradeReceiptTemplateId),
          writable: Boolean(write && tradeReceiptTemplateId),
          detail: tradeReceiptTemplateId
            ? "Per-trade DUAL receipt minting is configured."
            : "Set DUAL_TRADE_RECEIPT_TEMPLATE_ID to mint one DUAL receipt object per executed trade."
        },
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        eventBusWritePath,
        serviceAccount: {
          configured: Boolean(serviceToken || serviceRefreshToken),
          authMode: serviceAuthMode,
          refreshTokenConfigured: Boolean(serviceRefreshToken),
          writable: Boolean(serviceClient && writeMode === "event_bus"),
          error: null
        },
        emailSession: session ? {
          authenticated: true,
          email: maskEmail(session.email),
          orgId: session.orgId || null,
          authenticatedAt: session.authenticatedAt,
          refreshTokenPresent: session.refreshTokenPresent
        } : null,
        detail: read
          ? write
            ? "DUAL persistence adapter is ready for event-bus writes."
            : "DUAL passport is linked for read verification. Event-bus writes need DUAL_WRITE_MODE=event_bus."
          : sdkError
            ? `DUAL SDK unavailable: ${sdkError.message}`
            : "Set DUAL_API_KEY, DUAL_ORG_ID, and DUAL_AGENT_PASSPORT_TEMPLATE_ID."
      };
    },

    writeReadiness() {
      const status = this.status();
      const ready = Boolean(status.available && status.writable);
      return {
        ready,
        mode,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        eventBusWritePath,
        requiredAuthMode: "api_key",
        requiredWriteMode: "event_bus",
        current: status,
        missing: ready ? [] : [
          ...(status.available || DualClient ? [] : ["DUAL SDK/client availability"]),
          ...(activeReadClient() ? [] : ["DUAL_API_KEY with event-bus action create permission"]),
          ...(writeMode === "event_bus" ? [] : ["DUAL_WRITE_MODE=event_bus"]),
          "scoped DUAL API key with event-bus action create permission"
        ],
        detail: ready
          ? "DUAL event-bus write sync is enabled."
          : "DUAL read-link is active; event-bus write sync needs DUAL_WRITE_MODE=event_bus plus a scoped DUAL_API_KEY."
      };
    },

    authStatus() {
      const write = activeWriteClient();
      return {
        enabled: mode === "dual" && Boolean(DualClient),
        authenticated: Boolean(write),
        writable: Boolean(write),
        authType: sessionClient
          ? "email_session"
          : serviceClient && serviceRefreshToken
            ? "refresh_token_service_session"
            : serviceClient
              ? `${serviceClient.authMode}_service_account`
              : write
                ? `${client.authMode}_env`
                : null,
        serviceAccountConfigured: Boolean(serviceToken || serviceRefreshToken),
        serviceAccountRefreshConfigured: Boolean(serviceRefreshToken),
        pendingEmail: pendingEmail ? maskEmail(pendingEmail) : null,
        email: session ? maskEmail(session.email) : null,
        orgId: session?.orgId || orgId || null,
        authenticatedAt: session?.authenticatedAt || null,
        detail: write
          ? "Scoped API-key auth is active for unattended DUAL event-bus writes."
          : "Use DUAL_WRITE_MODE=event_bus with a scoped DUAL_API_KEY. Email-code auth remains available for private browser sessions."
      };
    },

    async requestEmailCode(email) {
      const normalized = normalizeEmail(email);
      const login = makeClient("", "bearer");
      await login.sdk.wallets.requestOtp(normalized);
      pendingEmail = normalized;
      return { requested: true, email: maskEmail(normalized), detail: "Email code requested. Enter the code to create a private browser session." };
    },

    async verifyEmailCode(email, code, options = {}) {
      const normalized = normalizeEmail(email || pendingEmail);
      const login = makeClient("", "bearer");
      const tokens = await login.sdk.wallets.loginWithOtp(normalized, String(code || "").trim());
      login.token = tokens.access_token;
      login.sdk.setToken(tokens.access_token);
      let active = tokens;
      if (orgId) {
        active = await login.sdk.wallets.switchOrganization(orgId);
        login.token = active.access_token;
        login.sdk.setToken(active.access_token);
      }
      sessionClient = login;
      session = {
        email: normalized,
        orgId: orgId || null,
        authenticatedAt: new Date().toISOString(),
        refreshTokenPresent: Boolean(active.refresh_token)
      };
      pendingEmail = null;
      options.onSession?.({ token: active.access_token, ...session });
      return {
        authenticated: true,
        writable: Boolean(activeWriteClient()),
        email: maskEmail(normalized),
        orgId: session.orgId,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        detail: "Private browser session authenticated. DUAL event-bus replay is ready if this wallet has action create permission."
      };
    },

    restoreEmailSession(restored) {
      if (!restored?.token || !restored.email) return false;
      sessionClient = makeClient(restored.token, "bearer");
      session = {
        email: restored.email,
        orgId: restored.orgId || orgId || null,
        authenticatedAt: restored.authenticatedAt || new Date().toISOString(),
        refreshTokenPresent: Boolean(restored.refreshTokenPresent)
      };
      return true;
    },

    clearEmailSession() {
      sessionClient = null;
      session = null;
      return true;
    },

    async createTemplate() {
      return requireWritable().sdk.templates.create(agentTemplatePayload());
    },

    async createTradeReceiptTemplate() {
      const write = requireWritable();
      const template = await write.sdk.templates.create(tradeReceiptTemplatePayload());
      const newTemplateId = template.id || template.template_id || template.templateId;
      if (newTemplateId) tradeReceiptTemplateId = newTemplateId;
      return {
        template: summarizeTemplate(template),
        vercelEnv: {
          DUAL_TRADE_RECEIPT_TEMPLATE_ID: newTemplateId
        },
        next: "Update Vercel production env vars with DUAL_TRADE_RECEIPT_TEMPLATE_ID, redeploy, then replay pending trade receipts."
      };
    },

    async createActionEnabledPassport(passport) {
      const write = requireWritable();
      const template = await write.sdk.templates.create(agentTemplatePayload());
      const newTemplateId = template.id || template.template_id || template.templateId;
      const properties = passportProperties(passport, { lastEventId: "passport_setup" });
      const mint = await writeAction(write, mintPayload(newTemplateId, properties, { source: "passport_setup" }));
      const object = await findObjectForTemplate(write.sdk, newTemplateId);
      return {
        template: summarizeTemplate(template),
        object: object ? summarizeObject(object) : null,
        mint: summarizeResult(mint),
        vercelEnv: {
          DUAL_AGENT_PASSPORT_TEMPLATE_ID: newTemplateId,
          DUAL_AGENT_PASSPORT_OBJECT_ID: object?.id || object?.object_id || object?.objectId || null
        },
        next: "Update Vercel production env vars to these ids, redeploy, then rerun authenticated DUAL replay."
      };
    },

    async syncPassport(passport, metadata = {}) {
      const write = requireWritable();
      const properties = passportProperties(passport, metadata);
      return writeAction(write, objectId ? updatePayload(objectId, properties, metadata) : mintPayload(templateId, properties, metadata));
    },

    buildTradeReceiptQueue(tradeReceipts = []) {
      const receipts = tradeReceipts.map((receipt) => {
        const properties = tradeReceiptProperties(receipt);
        const metadata = tradeReceiptMetadata(receipt);
        const payload = tradeReceiptTemplateId ? mintPayload(tradeReceiptTemplateId, properties, metadata) : null;
        const result = receipt.dualSync?.result || {};
        const actionId = result.actionId || null;
        const objectId = result.id || receipt.dualObjectId || null;
        const locallySynced = Boolean(receipt.dualSync?.synced && (actionId || objectId));
        const envelope = payload ? { actionName: "mint", properties, metadata, payload } : null;
        return {
          receiptId: receipt.id,
          proposalId: receipt.proposalId,
          pair: receipt.pair,
          notionalUsd: receipt.notionalUsd,
          receiptHash: receipt.receiptHash,
          eventId: receipt.eventId,
          eventHash: receipt.eventHash,
          synced: locallySynced,
          actionId,
          objectId,
          syncSource: locallySynced ? "local_receipt_action_id" : receipt.dualSync?.reason || "pending",
          ready: Boolean(tradeReceiptTemplateId),
          envelope,
          envelopeHash: envelope ? hashJson(envelope) : null
        };
      });
      const pending = receipts.filter((receipt) => !receipt.synced);
      return {
        ready: Boolean(tradeReceiptTemplateId),
        writable: Boolean(activeWriteClient() && tradeReceiptTemplateId),
        targetTemplateId: tradeReceiptTemplateId || null,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        receiptCount: receipts.length,
        syncedCount: receipts.length - pending.length,
        pendingCount: pending.length,
        rootHash: hashJson(receipts.map(tradeReceiptRootItem)),
        pendingRootHash: hashJson(pending.map(tradeReceiptRootItem)),
        receipts: pending,
        allReceipts: receipts
      };
    },

    async executeTradeReceiptReplayQueue(tradeReceipts = []) {
      const write = requireWritable();
      const queue = this.buildTradeReceiptQueue(tradeReceipts);
      if (!tradeReceiptTemplateId) {
        const error = new Error("DUAL_TRADE_RECEIPT_TEMPLATE_ID is required before trade receipts can be minted.");
        error.status = 409;
        throw error;
      }
      const executed = [];
      for (const receipt of [...queue.receipts].reverse()) {
        const result = await writeAction(write, receipt.envelope.payload);
        executed.push({ ...receipt, result: summarizeResult(result) });
      }
      return {
        executed: true,
        executedCount: executed.length,
        skippedCount: queue.syncedCount,
        receiptRoot: queue.rootHash,
        pendingReceiptRoot: queue.pendingRootHash,
        targetTemplateId: queue.targetTemplateId,
        receipts: executed
      };
    },

    buildReplayQueue(passport, audit = [], options = {}) {
      const events = audit.map((event) => {
        const properties = passportProperties(passport, {
          lastEventId: event.id,
          updatedAt: event.timestamp
        });
        const metadata = eventMetadata(event);
        const payload = objectId ? updatePayload(objectId, properties, metadata) : mintPayload(templateId, properties, metadata);
        const actionId = event.dualSync?.result?.actionId || null;
        const locallySynced = Boolean(event.dualSync?.synced && actionId);
        const durableCoverage = locallySynced ? null : durableEventCoverage(event, options.durableObject);
        const envelope = { actionName: objectId ? "update" : "mint", properties, metadata, payload };
        return {
          eventId: event.id,
          eventType: event.type,
          eventStatus: event.status,
          eventHash: event.provenanceHash || event.id,
          synced: locallySynced || Boolean(durableCoverage),
          actionId,
          syncSource: locallySynced ? "local_audit_action_id" : durableCoverage?.reason || "pending",
          durableEventId: durableCoverage?.durableEventId || null,
          durableEventHash: durableCoverage?.durableEventHash || null,
          ready: Boolean(objectId || templateId),
          envelope,
          envelopeHash: hashJson(envelope)
        };
      });
      const pending = events.filter((event) => !event.synced);
      return {
        ready: Boolean(objectId || templateId),
        writable: Boolean(activeWriteClient()),
        targetObjectId: objectId || null,
        targetTemplateId: templateId || null,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        eventCount: events.length,
        syncedCount: events.length - pending.length,
        pendingCount: pending.length,
        rootHash: hashJson(events.map(rootItem)),
        pendingRootHash: hashJson(pending.map(rootItem)),
        events: pending,
        allEvents: events
      };
    },

    async executeReplayQueue(passport, audit = [], options = {}) {
      const write = requireWritable();
      const queue = this.buildReplayQueue(passport, audit, options);
      const executed = [];
      for (const event of [...queue.events].reverse()) {
        const result = await writeAction(write, event.envelope.payload);
        executed.push({ ...event, result: summarizeResult(result) });
      }
      return {
        executed: true,
        executedCount: executed.length,
        skippedCount: queue.syncedCount,
        replayRoot: queue.rootHash,
        pendingReplayRoot: queue.pendingRootHash,
        targetObjectId: queue.targetObjectId,
        targetTemplateId: queue.targetTemplateId,
        events: executed
      };
    },

    async readPassportObject() {
      const read = activeReadClient();
      if (!read || !objectId) return { available: false, reason: objectId ? this.status().detail : "Set DUAL_AGENT_PASSPORT_OBJECT_ID." };
      return { available: true, ...summarizeObject(await read.sdk.objects.get(objectId)) };
    },

    async readPassportTemplate() {
      const read = activeReadClient();
      if (!read || !templateId) return { available: false, reason: templateId ? this.status().detail : "Set DUAL_AGENT_PASSPORT_TEMPLATE_ID." };
      return { available: true, ...summarizeTemplate(await read.sdk.templates.get(templateId)) };
    },

    async readTradeReceiptTemplate() {
      const read = activeReadClient();
      if (!read || !tradeReceiptTemplateId) {
        return {
          available: false,
          reason: tradeReceiptTemplateId ? this.status().detail : "Set DUAL_TRADE_RECEIPT_TEMPLATE_ID."
        };
      }
      return { available: true, ...summarizeTemplate(await read.sdk.templates.get(tradeReceiptTemplateId)) };
    },

    async readLatestBatchProof() {
      const read = activeReadClient();
      if (!read?.sdk?.sequencer?.listBatches) return { available: false, reason: "DUAL sequencer batch API is unavailable in this SDK/runtime." };
      const response = await read.sdk.sequencer.listBatches({ limit: 10 });
      const batch = extractItems(response).map(summarizeBatch).filter(Boolean)[0];
      return batch ? { available: true, ...batch, finality: describeBatchFinality(batch) } : { available: false, reason: "No DUAL sequencer batches were returned." };
    },

    async recordEvent(passport, event) {
      const write = activeWriteClient();
      if (!activeReadClient()) return { skipped: true, reason: this.status().detail };
      const properties = passportProperties(passport, {
        lastEventId: event.id,
        updatedAt: event.timestamp
      });
      const metadata = eventMetadata(event);
      const payload = objectId ? updatePayload(objectId, properties, metadata) : mintPayload(templateId, properties, metadata);
      if (!write) return { skipped: true, reason: "DUAL event-bus writes need DUAL_WRITE_MODE=event_bus plus a scoped DUAL_API_KEY.", replay: { envelope: payload, envelopeHash: hashJson(payload) } };
      const result = await writeAction(write, payload);
      return { synced: true, envelopeHash: hashJson(payload), result: summarizeResult(result) };
    },

    async recordTradeReceipt(receipt) {
      const write = activeWriteClient();
      if (!activeReadClient()) return { skipped: true, reason: this.status().detail };
      if (!tradeReceiptTemplateId) {
        return {
          skipped: true,
          reason: "Set DUAL_TRADE_RECEIPT_TEMPLATE_ID to mint per-trade DUAL receipt objects."
        };
      }
      const properties = tradeReceiptProperties(receipt);
      const metadata = tradeReceiptMetadata(receipt);
      const payload = mintPayload(tradeReceiptTemplateId, properties, metadata);
      if (!write) {
        return {
          skipped: true,
          reason: "DUAL trade receipt minting needs DUAL_WRITE_MODE=event_bus plus a scoped DUAL_API_KEY.",
          replay: { envelope: payload, envelopeHash: hashJson(payload) }
        };
      }
      const result = await writeAction(write, payload);
      return { synced: true, envelopeHash: hashJson(payload), result: summarizeResult(result) };
    },

    async probeUpdateSchemas(passport) {
      const write = requireWritable();
      const properties = passportProperties(passport, { lastEventId: "schema_probe" });
      const payload = updatePayload(objectId, properties, { source: "schema_probe" });
      const result = await writeAction(write, payload);
      return { targetObjectId: objectId, targetTemplateId: templateId, results: [{ name: "v3_action_parameters", ok: true, result: summarizeResult(result) }] };
    }
  };

  function makeClient(token, modeName) {
    const sdk = new DualClient({ baseUrl, token, authMode: modeName, timeout: 30000 });
    return { sdk, token, authMode: modeName };
  }

  function activeReadClient() {
    return sessionClient || client || serviceClient;
  }

  function activeWriteClient() {
    if (writeMode !== "event_bus") return null;
    return sessionClient || serviceClient || client;
  }

  function requireWritable() {
    const write = activeWriteClient();
    if (!write) {
      const error = new Error("DUAL event-bus write auth is not ready.");
      error.status = 409;
      throw error;
    }
    return write;
  }

  function effectiveAuthMode() {
    if (sessionClient) return "bearer_email_session";
    if (serviceClient) return `${serviceClient.authMode}_service_account`;
    return client?.authMode || authMode;
  }

  function effectiveWriteMode() {
    return activeWriteClient() ? "event_bus" : writeMode;
  }

  async function writeAction(write, payload) {
    if (eventBusWritePath === "/ebus/execute" && write.sdk.eventBus?.execute) {
      return write.sdk.eventBus.execute(payload);
    }
    const response = await fetch(`${baseUrl}${eventBusWritePath}`, {
      method: "POST",
      headers: authHeaders(write),
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `DUAL event-bus write failed with HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
}

function normalizeAuthMode(modeName) {
  const normalized = String(modeName || "api_key").toLowerCase().replace("-", "_");
  if (normalized === "both") return "api_key";
  if (normalized === "api_key" || normalized === "bearer") return normalized;
  return "api_key";
}

function authHeaders(write) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (write.authMode === "api_key") headers["x-api-key"] = write.token;
  if (write.authMode === "bearer") headers.authorization = `Bearer ${write.token}`;
  return headers;
}

function updatePayload(targetObjectId, properties, metadata) {
  return {
    action: {
      update: {
        id: targetObjectId,
        data: {
          custom: {
            ...properties,
            last_event_type: metadata.event_type || "",
            last_event_status: metadata.event_status || "",
            last_event_hash: metadata.event_hash || ""
          }
        }
      }
    },
    metadata
  };
}

function mintPayload(targetTemplateId, properties, metadata) {
  return {
    action: {
      mint: {
        template_id: targetTemplateId,
        num: 1,
        custom: {
          ...properties,
          last_event_type: metadata.event_type || "",
          last_event_status: metadata.event_status || "",
          last_event_hash: metadata.event_hash || ""
        }
      }
    },
    metadata
  };
}

function agentTemplatePayload() {
  const custom = passportProperties({}, {});
  return {
    name: `io.dual.kraken.agent_trading_passport.action_enabled.${Date.now()}`,
    description: "Policy-bound agent passport for Kraken paper/live trading governance.",
    organization_id: process.env.DUAL_ORG_ID || undefined,
    object: {
      metadata: {
        name: "Kraken Market Agent Passport",
        description: "A DUAL-governed trading-agent passport for Kraken market data, mandate checks, paper execution, and event replay."
      },
      custom
    },
    actions: [
      { name: "mint", alias: "issue_kraken_agent_passport" },
      { name: "update", alias: "record_kraken_agent_event" }
    ],
    public_access: { custom: Object.keys(custom) }
  };
}

function tradeReceiptTemplatePayload() {
  const custom = tradeReceiptProperties({});
  return {
    name: `io.dual.kraken.trade_receipt.action_enabled.${Date.now()}`,
    description: "One DUAL receipt object per Kraken paper trade execution.",
    organization_id: process.env.DUAL_ORG_ID || undefined,
    object: {
      metadata: {
        name: "Kraken Paper Trade Receipt",
        description: "A minted receipt for a DUAL-governed Kraken paper trade, linked to the agent passport, proposal, policy hash, execution digest, and audit event."
      },
      custom
    },
    actions: [
      { name: "mint", alias: "mint_kraken_trade_receipt" }
    ],
    public_access: { custom: Object.keys(custom) }
  };
}

function passportProperties(passport = {}, metadata = {}) {
  const policy = {
    allowedPairs: passport.allowedPairs || ["BTCUSD", "ETHUSD", "SOLUSD", "DUALUSD"],
    maxNotionalUsd: passport.maxNotionalUsd || 250,
    maxDailyNotionalUsd: passport.maxDailyNotionalUsd || 1000,
    humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove || 100,
    leverageAllowed: Boolean(passport.leverageAllowed),
    approvalPolicy: passport.approvalPolicy || "human_required_above_threshold",
    policyVersion: passport.policyVersion || 1
  };
  return {
    passport_id: passport.id || "kraken-market-agent-passport",
    agent_name: passport.agentName || "Kraken Market Agent",
    mode: passport.mode || "paper",
    state: passport.dualObjectState || passport.state || "active",
    allowed_pairs: policy.allowedPairs,
    max_notional_usd: String(policy.maxNotionalUsd),
    max_daily_notional_usd: String(policy.maxDailyNotionalUsd),
    human_approval_required_above: String(policy.humanApprovalRequiredAbove),
    leverage_allowed: String(policy.leverageAllowed),
    approval_policy: policy.approvalPolicy,
    policy_version: String(policy.policyVersion),
    policy_hash: passport.policyHash || hashJson(policy),
    daily_notional_used: String(passport.dailyNotionalUsed || 0),
    blocked_actions: passport.blockedActions || [],
    last_event_id: metadata.lastEventId || passport.lastEventId || "initial",
    updated_at: metadata.updatedAt || new Date().toISOString()
  };
}

function eventMetadata(event) {
  return {
    event_id: event.id,
    event_type: event.type,
    event_status: event.status,
    event_hash: event.provenanceHash || event.id,
    event_payload: event.payload || {}
  };
}

function durableEventCoverage(event, durableObject = null) {
  const custom = durableObject?.custom || durableObject?.data?.custom || {};
  const durableEventId = custom.last_event_id || "";
  if (!durableEventId) return null;

  const durableEventHash = custom.last_event_hash || "";
  const eventHash = event.provenanceHash || event.id;
  if (durableEventId === event.id && (!durableEventHash || durableEventHash === eventHash)) {
    return { reason: "durable_object_readback", durableEventId, durableEventHash };
  }

  const eventTime = Date.parse(event.timestamp || "");
  const durableTime = Date.parse(custom.updated_at || durableObject.whenModified || durableObject.updatedAt || "");
  if (Number.isFinite(eventTime) && Number.isFinite(durableTime) && durableTime > eventTime && durableEventId !== event.id) {
    return { reason: "superseded_by_durable_object", durableEventId, durableEventHash };
  }

  return null;
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return result || null;
  return {
    id: result.id || result.object_id || result.objectId || result.event_id || result.eventId || null,
    status: result.status || result.state || null,
    hash: result.hash || result.integrity_hash || result.integrityHash || result.state_hash || result.stateHash || null,
    actionId: result.action_id || result.actionId || result.id || null,
    batchId: result.batch_id || result.batchId || null,
    payloadStyle: "nested_data_custom"
  };
}

function summarizeTemplate(template) {
  return {
    id: template?.id || template?.template_id || template?.templateId || null,
    name: template?.name || null,
    custom: template?.object?.custom || template?.properties || {},
    actions: template?.actions || null,
    publicAccess: template?.public_access || template?.publicAccess || null,
    whenModified: template?.when_modified || template?.updated_at || template?.updatedAt || null
  };
}

function summarizeObject(object) {
  return {
    id: object?.id || object?.object_id || object?.objectId || null,
    templateId: object?.template_id || object?.templateId || null,
    orgId: object?.org_id || object?.organization_id || null,
    owner: object?.owner || object?.owner_id || null,
    custom: object?.custom || object?.properties || {},
    integrityHash: object?.integrity_hash || object?.integrityHash || null,
    stateHash: object?.state_hash || object?.stateHash || null,
    whenModified: object?.when_modified || object?.updated_at || object?.updatedAt || null
  };
}

async function findObjectForTemplate(sdk, templateId) {
  for (let index = 0; index < 5; index += 1) {
    const found = await searchObjects(sdk, templateId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

async function searchObjects(sdk, templateId) {
  for (const method of ["search", "list"]) {
    try {
      const result = await sdk.objects[method]({ template_id: templateId, limit: 10 });
      const items = extractItems(result);
      if (items.length) return items[0];
    } catch {
      // Gateways differ on search/list support.
    }
  }
  return null;
}

function summarizeBatch(batch) {
  if (!batch || typeof batch !== "object") return null;
  return {
    id: batch.id || batch.batch_id || batch.batchId || null,
    status: batch.status || batch.state || null,
    proofValue: batch.proof_value || batch.proofValue || batch.proof?.value || batch.proof?.status || null,
    actionCount: batch.action_count ?? batch.actions_count ?? batch.actionCount ?? batch.actions?.length ?? null,
    actionsHash: batch.actions_hash || batch.actionsHash || null,
    affectedActions: extractBatchActions(batch),
    commitment: batch.commitment || null,
    hash: batch.hash || null,
    integrityRoot: batch.integrity_root || batch.integrityRoot || null,
    ipfsUrl: batch.ipfs_url || batch.ipfsUrl || null,
    prevHash: batch.prev_hash || batch.prevHash || null,
    proof: batch.proof || null,
    sequence: batch.sequence ?? null,
    totalFee: batch.total_fee || batch.totalFee || null,
    totalFeeWei: batch.total_fee_wei || batch.totalFeeWei || null,
    merkleRoot: batch.merkle_root || batch.merkleRoot || batch.root_hash || batch.rootHash || null,
    checkpointId: batch.checkpoint_id || batch.checkpointId || batch.checkpoint?.id || null,
    transactionHash: nonZeroHash(batch.transaction_hash || batch.transactionHash || batch.tx_hash || batch.txHash || batch.l1_tx_hash || batch.l1TxHash),
    chainId: batch.chain_id || batch.chainId || batch.network || batch.chain || null,
    createdAt: batch.created_at || batch.createdAt || batch.when_created || batch.whenCreated || null,
    updatedAt: batch.updated_at || batch.updatedAt || batch.when_modified || batch.whenModified || null
  };
}

function extractBatchActions(batch) {
  const actions = batch?.affected_actions || batch?.affectedActions || batch?.actions || [];
  return Array.isArray(actions)
    ? actions.map((action) => ({
      id: action.id || action.action_id || action.actionId || null,
      name: action.name || action.action_name || action.actionName || null,
      hash: action.hash || action.action_hash || action.actionHash || null
    })).filter((action) => action.id || action.hash)
    : [];
}

function describeBatchFinality(batch) {
  const status = String(batch?.status || "").toLowerCase();
  const proofValue = String(batch?.proofValue || "").toLowerCase();
  if (batch?.transactionHash || /final|confirmed|complete|completed|anchored/.test(status)) return "finalized";
  if (proofValue === "success" || status === "anchoring") return "proof-success";
  if (/fail|error|reject/.test(status) || /fail|error|reject/.test(proofValue)) return "failed";
  return status || proofValue ? "pending" : "unknown";
}

function extractItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.objects)) return response.objects;
  if (Array.isArray(response?.batches)) return response.batches;
  if (Array.isArray(response?.data?.items)) return response.data.items;
  if (Array.isArray(response?.data?.batches)) return response.data.batches;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function rootItem(event) {
  return {
    eventId: event.eventId,
    eventHash: event.eventHash,
    actionId: event.actionId,
    envelopeHash: event.envelopeHash
  };
}

function tradeReceiptRootItem(receipt) {
  return {
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    proposalId: receipt.proposalId,
    eventId: receipt.eventId,
    actionId: receipt.actionId,
    objectId: receipt.objectId,
    envelopeHash: receipt.envelopeHash
  };
}

function normalizePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "execute") return "/ebus/execute";
  if (raw === "actions") return "/ebus/actions";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const error = new Error("Enter a valid email address for DUAL authentication.");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  return name && domain ? `${name.slice(0, 2)}***@${domain}` : null;
}

function nonZeroHash(value) {
  const text = String(value || "");
  return text && !/^0x0+$/.test(text) ? text : null;
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
