import crypto from "node:crypto";

export async function createDualPersistence() {
  const mode = process.env.DUAL_PERSISTENCE_MODE || "local";
  const orgId = process.env.DUAL_ORG_ID || "";
  const templateId = process.env.DUAL_AGENT_PASSPORT_TEMPLATE_ID || "";
  const objectId = process.env.DUAL_AGENT_PASSPORT_OBJECT_ID || "";
  const baseUrl = process.env.DUAL_API_URL || "https://api-testnet.dual.network";
  const apiKey = process.env.DUAL_API_KEY || "";
  const authMode = normalizeAuthMode(process.env.DUAL_AUTH_MODE || "api_key");
  const writeMode = process.env.DUAL_WRITE_MODE || "read_only";
  const eventBusWritePath = normalizePath(process.env.DUAL_EVENTBUS_WRITE_PATH || "/ebus/execute");
  const serviceToken = process.env.DUAL_SERVICE_ACCOUNT_TOKEN || process.env.DUAL_SERVICE_ACCOUNT_BEARER_TOKEN || process.env.DUAL_BEARER_TOKEN || "";
  const serviceRefreshToken = process.env.DUAL_SERVICE_ACCOUNT_REFRESH_TOKEN || "";
  const serviceAuthMode = normalizeAuthMode(process.env.DUAL_SERVICE_ACCOUNT_AUTH_MODE || "api_key");

  let DualClient = null;
  let client = null;
  let serviceClient = null;
  let sessionClient = null;
  let session = null;
  let serviceSession = null;
  let pendingEmail = null;
  let sdkError = null;
  let preferredPayloadStyle = process.env.DUAL_EVENTBUS_PAYLOAD_STYLE || "direct_custom";

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
        let active = tokens;
        try {
          active = await refreshed.sdk.wallets.switchOrganization(orgId);
          refreshed.token = active.access_token;
          refreshed.sdk.setToken(active.access_token);
        } catch {
          // Some refresh tokens are already org scoped.
        }
        serviceClient = refreshed;
        serviceSession = { orgId, refreshedAt: new Date().toISOString(), refreshTokenPresent: Boolean(active.refresh_token || tokens.refresh_token) };
      }
    } catch (error) {
      sdkError = error;
    }
  }

  return {
    status() {
      const read = activeReadClient();
      const write = activeWriteClient();
      if (mode !== "dual") return { mode: "local", configured: false, available: true, writable: false, detail: "Using local DUAL passport simulator." };
      return {
        mode: "dual",
        configured: Boolean((apiKey || serviceToken || serviceRefreshToken || sessionClient) && orgId && templateId),
        available: Boolean(read),
        writable: Boolean(write),
        orgId: orgId || null,
        templateId: templateId || null,
        objectId: objectId || null,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        eventBusWritePath,
        serviceAccount: {
          configured: Boolean(serviceToken || serviceRefreshToken),
          authMode: serviceAuthMode,
          refreshTokenConfigured: Boolean(serviceRefreshToken),
          session: serviceSession,
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
            ? "DUAL persistence adapter is ready for direct event-bus writes."
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
          ? "DUAL event-bus write sync is enabled via direct server-side POST."
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
              ? `${directEventBusAuthMode(serviceClient)}_service_account`
              : write
                ? `${directEventBusAuthMode(client)}_env`
                : null,
        serviceAccountConfigured: Boolean(serviceToken || serviceRefreshToken),
        serviceAccountRefreshConfigured: Boolean(serviceRefreshToken),
        pendingEmail: pendingEmail ? maskEmail(pendingEmail) : null,
        email: session ? maskEmail(session.email) : null,
        orgId: session?.orgId || serviceSession?.orgId || orgId || null,
        authenticatedAt: session?.authenticatedAt || serviceSession?.refreshedAt || null,
        detail: write
          ? "Scoped API-key auth is active for direct DUAL event-bus writes."
          : "Use DUAL_WRITE_MODE=event_bus with a scoped DUAL_API_KEY. Email-code auth remains available for operator sessions."
      };
    },

    async requestEmailCode(email) {
      const normalized = normalizeEmail(email);
      const login = makeClient("", "bearer");
      await login.sdk.wallets.requestOtp(normalized);
      pendingEmail = normalized;
      return { requested: true, email: maskEmail(normalized), detail: "Email code requested. Enter the code to create an operator session." };
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
      session = { email: normalized, orgId: orgId || null, authenticatedAt: new Date().toISOString(), refreshTokenPresent: Boolean(active.refresh_token) };
      pendingEmail = null;
      options.onSession?.({ token: active.access_token, ...session });
      return { authenticated: true, writable: Boolean(activeWriteClient()), email: maskEmail(normalized), orgId: session.orgId, authMode: effectiveAuthMode(), writeMode: effectiveWriteMode(), detail: "Operator session authenticated. DUAL event-bus replay is ready if this wallet has action create permission." };
    },

    restoreEmailSession(restored) {
      if (!restored?.token || !restored.email) return false;
      sessionClient = makeClient(restored.token, "bearer");
      session = { email: restored.email, orgId: restored.orgId || orgId || null, authenticatedAt: restored.authenticatedAt || new Date().toISOString(), refreshTokenPresent: Boolean(restored.refreshTokenPresent) };
      return true;
    },

    async createTemplate() {
      return requireWritable().sdk.templates.create(agentTemplatePayload());
    },

    async createActionEnabledPassport(passport) {
      const write = requireWritable();
      const template = await write.sdk.templates.create(agentTemplatePayload());
      const newTemplateId = template.id || template.template_id || template.templateId;
      const properties = passportProperties(passport, { lastEventId: "passport_setup" });
      const mint = await writeActionWithFallback(write, "mint", newTemplateId, null, properties, { source: "passport_setup", event_type: "passport_setup", event_status: "created" });
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
      return writeActionWithFallback(write, objectId ? "update" : "mint", templateId, objectId, properties, metadata);
    },

    buildReplayQueue(passport, audit = [], options = {}) {
      const events = audit.map((event) => {
        const properties = passportProperties(passport, { lastEventId: event.id });
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
        const result = await writeActionWithFallback(write, event.envelope.actionName, queue.targetTemplateId, queue.targetObjectId, event.envelope.properties, event.envelope.metadata);
        executed.push({ ...event, result: summarizeResult(result) });
      }
      return { executed: true, executedCount: executed.length, skippedCount: queue.syncedCount, replayRoot: queue.rootHash, pendingReplayRoot: queue.pendingRootHash, targetObjectId: queue.targetObjectId, targetTemplateId: queue.targetTemplateId, events: executed };
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
      const properties = passportProperties(passport, { lastEventId: event.id });
      const metadata = eventMetadata(event);
      const payload = objectId ? updatePayload(objectId, properties, metadata) : mintPayload(templateId, properties, metadata);
      if (!write) return { skipped: true, reason: "DUAL event-bus writes need DUAL_WRITE_MODE=event_bus plus a scoped DUAL_API_KEY.", replay: { envelope: payload, envelopeHash: hashJson(payload) } };
      const result = await writeActionWithFallback(write, objectId ? "update" : "mint", templateId, objectId, properties, metadata);
      return { synced: true, envelopeHash: hashJson(payload), result: summarizeResult(result) };
    },

    async probeUpdateSchemas(passport) {
      const write = requireWritable();
      const properties = passportProperties(passport, { lastEventId: `api_key_probe_${Date.now()}` });
      const metadata = { source: "api_key_execute_probe", event_type: "api_key_execute_probe", event_status: "ok" };
      const result = await writeActionWithFallback(write, "update", templateId, objectId, properties, metadata);
      return { targetObjectId: objectId, targetTemplateId: templateId, authMode: directEventBusAuthMode(write), eventBusWritePath, payloadStyle: preferredPayloadStyle, results: [{ name: preferredPayloadStyle, ok: true, result: summarizeResult(result) }] };
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
    if (write) return write;
    const error = new Error("DUAL event-bus write auth is not ready.");
    error.status = 409;
    throw error;
  }

  function normalizeAuthMode(modeName) {
    const normalized = String(modeName || "api_key").toLowerCase().replace("-", "_");
    if (normalized === "both") return "api_key";
    if (normalized === "api_key" || normalized === "bearer") return normalized;
    return "api_key";
  }

  function effectiveAuthMode() {
    if (sessionClient) return "bearer_email_session";
    if (serviceClient) return serviceSession ? "bearer_service_account" : `${directEventBusAuthMode(serviceClient)}_service_account`;
    return directEventBusAuthMode(client || {});
  }

  function effectiveWriteMode() {
    return activeWriteClient() ? "event_bus" : writeMode;
  }

  async function writeActionWithFallback(write, actionName, targetTemplateId, targetObjectId, properties, metadata) {
    const attempts = payloadAttempts(actionName, targetTemplateId, targetObjectId, properties, metadata);
    const errors = [];
    for (const attempt of attempts) {
      try {
        const result = await writeAction(write, attempt.payload);
        preferredPayloadStyle = attempt.style;
        return { ...summarizeResult(result), raw: result, payloadStyle: attempt.style };
      } catch (error) {
        errors.push({ style: attempt.style, status: error.status || null, message: error.message, body: error.body || null });
      }
    }
    const error = new Error(`DUAL event-bus action write failed. ${errors.map((item) => `${item.style}: ${item.message}`).join(" | ")}`);
    error.status = errors[0]?.status || 400;
    error.body = { attempts: errors };
    throw error;
  }

  function payloadAttempts(actionName, targetTemplateId, targetObjectId, properties, metadata) {
    const styles = preferredPayloadStyle === "auto"
      ? ["direct_custom", "direct_data_custom", "top_level_action", "classic_custom"]
      : [preferredPayloadStyle, ...["direct_custom", "direct_data_custom", "top_level_action", "classic_custom"].filter((style) => style !== preferredPayloadStyle)];
    return styles.map((style) => ({ style, payload: actionName === "update" ? updatePayloadByStyle(style, targetObjectId, properties, metadata) : mintPayloadByStyle(style, targetTemplateId, properties, metadata) }));
  }

  async function writeAction(write, payload) {
    const response = await fetch(`${baseUrl}${eventBusWritePath}`, { method: "POST", headers: directEventBusHeaders(write), body: JSON.stringify(payload) });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
    if (response.ok) return body;
    const error = new Error(messageFromBody(body, `DUAL event-bus write failed with HTTP ${response.status}`));
    error.status = response.status;
    error.body = body;
    throw error;
  }

  function directEventBusAuthMode(write) {
    if (write === sessionClient) return "bearer";
    if (write === serviceClient && serviceSession) return "bearer";
    if (write === serviceClient) return serviceAuthMode;
    return authMode;
  }

  function directEventBusHeaders(write) {
    const token = write?.token || write?.sdk?.getToken?.();
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (!token) return headers;
    const modeName = directEventBusAuthMode(write);
    if (modeName === "bearer") headers.authorization = `Bearer ${token}`;
    else headers["x-api-key"] = token;
    return headers;
  }
}

function updatePayload(targetObjectId, properties, metadata) {
  return updatePayloadByStyle("direct_custom", targetObjectId, properties, metadata);
}

function updatePayloadByStyle(style, targetObjectId, properties, metadata) {
  const custom = withEventFields(properties, metadata);
  if (style === "direct_data_custom") return { action: { update: { id: targetObjectId, data: { custom } } }, metadata };
  if (style === "top_level_action") return { action: "update", object_id: targetObjectId, custom, metadata };
  if (style === "classic_custom") return { this: targetObjectId, action: "update", custom, metadata };
  return { action: { update: { id: targetObjectId, custom } }, metadata };
}

function mintPayload(targetTemplateId, properties, metadata) {
  return mintPayloadByStyle("direct_custom", targetTemplateId, properties, metadata);
}

function mintPayloadByStyle(style, targetTemplateId, properties, metadata) {
  const custom = withEventFields(properties, metadata);
  if (style === "direct_data_custom") return { action: { mint: { template_id: targetTemplateId, num: 1, data: { custom } } }, metadata };
  if (style === "top_level_action") return { action: "mint", template_id: targetTemplateId, num: 1, custom, metadata };
  if (style === "classic_custom") return { template: targetTemplateId, action: "mint", custom, metadata };
  return { action: { mint: { template_id: targetTemplateId, num: 1, custom } }, metadata };
}

function withEventFields(properties, metadata = {}) {
  return {
    ...properties,
    last_event_type: metadata.event_type || "",
    last_event_status: metadata.event_status || "",
    last_event_hash: metadata.event_hash || ""
  };
}

function agentTemplatePayload() {
  const custom = passportProperties({}, {});
  return { name: `io.dual.kraken.agent_trading_passport.action_enabled.${Date.now()}`, description: "Policy-bound agent passport for Kraken paper/live trading governance.", organization_id: process.env.DUAL_ORG_ID || undefined, object: { metadata: { name: "Kraken Market Agent Passport", description: "A DUAL-governed trading-agent passport for Kraken market data, mandate checks, paper execution, and event replay." }, custom }, actions: [{ name: "mint", alias: "issue_kraken_agent_passport" }, { name: "update", alias: "record_kraken_agent_event" }], public_access: { custom: Object.keys(custom) } };
}

function passportProperties(passport = {}, metadata = {}) {
  const policy = { allowedPairs: passport.allowedPairs || ["BTCUSD", "ETHUSD", "SOLUSD"], maxNotionalUsd: passport.maxNotionalUsd || 250, maxDailyNotionalUsd: passport.maxDailyNotionalUsd || 1000, humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove || 100, leverageAllowed: Boolean(passport.leverageAllowed), approvalPolicy: passport.approvalPolicy || "human_required_above_threshold", policyVersion: passport.policyVersion || 1 };
  return { passport_id: passport.id || "kraken-market-agent-passport", agent_name: passport.agentName || "Kraken Market Agent", mode: passport.mode || "paper", state: passport.dualObjectState || passport.state || "active", allowed_pairs: policy.allowedPairs, max_notional_usd: String(policy.maxNotionalUsd), max_daily_notional_usd: String(policy.maxDailyNotionalUsd), human_approval_required_above: String(policy.humanApprovalRequiredAbove), leverage_allowed: String(policy.leverageAllowed), approval_policy: policy.approvalPolicy, policy_version: String(policy.policyVersion), policy_hash: passport.policyHash || hashJson(policy), daily_notional_used: String(passport.dailyNotionalUsed || 0), blocked_actions: passport.blockedActions || [], owner_wallet: passport.ownerWallet || "", last_event_id: metadata.lastEventId || passport.lastEventId || "initial", updated_at: new Date().toISOString() };
}

function eventMetadata(event) {
  return { event_id: event.id, event_type: event.type, event_status: event.status, event_hash: event.provenanceHash || event.id, event_payload: event.payload || {} };
}

function durableEventCoverage(event, durableObject = null) {
  const custom = durableObject?.custom || durableObject?.data?.custom || {};
  const durableEventId = custom.last_event_id || "";
  if (!durableEventId) return null;
  const durableEventHash = custom.last_event_hash || "";
  const eventHash = event.provenanceHash || event.id;
  if (durableEventId === event.id && (!durableEventHash || durableEventHash === eventHash)) return { reason: "durable_object_readback", durableEventId, durableEventHash };
  const eventTime = Date.parse(event.timestamp || "");
  const durableTime = Date.parse(custom.updated_at || durableObject.whenModified || durableObject.updatedAt || "");
  if (Number.isFinite(eventTime) && Number.isFinite(durableTime) && durableTime > eventTime && durableEventId !== event.id) return { reason: "superseded_by_durable_object", durableEventId, durableEventHash };
  return null;
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return result || null;
  const data = objectOrNull(result.data) || result;
  const inner = objectOrNull(data.result) || objectOrNull(result.result) || data;
  const action = objectOrNull(inner.action) || objectOrNull(data.action) || objectOrNull(result.action) || inner;
  const update = objectOrNull(action.update) || null;
  const mint = objectOrNull(action.mint) || null;
  const object = objectOrNull(inner.object) || objectOrNull(data.object) || objectOrNull(result.object) || null;
  return { id: first(result.id, result.object_id, result.objectId, result.event_id, result.eventId, data.id, data.object_id, data.objectId, inner.id, inner.object_id, inner.objectId, action.id, update?.id, mint?.id, object?.id, object?.object_id, object?.objectId), status: first(result.status, result.state, data.status, data.state, inner.status, inner.state, action.status, action.state, update?.status, update?.state, mint?.status, mint?.state), hash: first(result.hash, result.integrity_hash, result.integrityHash, result.state_hash, result.stateHash, data.hash, data.integrity_hash, data.integrityHash, inner.hash, inner.integrity_hash, inner.integrityHash, action.hash, action.integrity_hash, action.integrityHash, object?.integrity_hash, object?.integrityHash), actionId: first(result.action_id, result.actionId, data.action_id, data.actionId, inner.action_id, inner.actionId, action.action_id, action.actionId, update?.action_id, update?.actionId, mint?.action_id, mint?.actionId, action.id, update?.id, mint?.id, result.id, data.id, inner.id), batchId: first(result.batch_id, result.batchId, data.batch_id, data.batchId, inner.batch_id, inner.batchId, action.batch_id, action.batchId, update?.batch_id, update?.batchId, mint?.batch_id, mint?.batchId) };
}

function summarizeTemplate(template) {
  return { id: template?.id || template?.template_id || template?.templateId || null, name: template?.name || null, custom: template?.object?.custom || template?.properties || {}, actions: template?.actions || null, publicAccess: template?.public_access || template?.publicAccess || null, whenModified: template?.when_modified || template?.updated_at || template?.updatedAt || null };
}

function summarizeObject(object) {
  return { id: object?.id || object?.object_id || object?.objectId || null, templateId: object?.template_id || object?.templateId || null, orgId: object?.org_id || object?.organization_id || null, owner: object?.owner || object?.owner_id || null, custom: object?.custom || object?.properties || {}, integrityHash: object?.integrity_hash || object?.integrityHash || null, stateHash: object?.state_hash || object?.stateHash || null, whenModified: object?.when_modified || object?.updated_at || object?.updatedAt || null };
}

async function findObjectForTemplate(sdk, targetTemplateId) {
  for (let index = 0; index < 5; index += 1) {
    const found = await searchObjects(sdk, targetTemplateId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

async function searchObjects(sdk, targetTemplateId) {
  for (const method of ["search", "list"]) {
    try {
      const result = await sdk.objects[method]({ template_id: targetTemplateId, limit: 10 });
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
  return { id: batch.id || batch.batch_id || batch.batchId || null, status: batch.status || batch.state || null, proofValue: batch.proof_value || batch.proofValue || batch.proof?.value || batch.proof?.status || null, actionCount: batch.action_count ?? batch.actions_count ?? batch.actionCount ?? batch.actions?.length ?? extractBatchActions(batch).length ?? null, merkleRoot: batch.merkle_root || batch.merkleRoot || batch.root_hash || batch.rootHash || null, checkpointId: batch.checkpoint_id || batch.checkpointId || batch.checkpoint?.id || null, transactionHash: nonZeroHash(batch.transaction_hash || batch.transactionHash || batch.tx_hash || batch.txHash || batch.l1_tx_hash || batch.l1TxHash), chainId: batch.chain_id || batch.chainId || batch.network || batch.chain || null, createdAt: batch.created_at || batch.createdAt || batch.when_created || batch.whenCreated || null, updatedAt: batch.updated_at || batch.when_modified || batch.whenModified || null };
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

function extractBatchActions(batch) {
  if (Array.isArray(batch?.affected_actions)) return batch.affected_actions;
  if (Array.isArray(batch?.affectedActions)) return batch.affectedActions;
  if (Array.isArray(batch?.actions)) return batch.actions;
  if (Array.isArray(batch?.data?.affected_actions)) return batch.data.affected_actions;
  return [];
}

function rootItem(event) {
  return { eventId: event.eventId, eventHash: event.eventHash, actionId: event.actionId, envelopeHash: event.envelopeHash };
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

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") || null;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function messageFromBody(body, fallback) {
  if (typeof body === "string") return body || fallback;
  return body?.message || body?.error || fallback;
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
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
