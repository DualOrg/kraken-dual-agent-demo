import crypto from "node:crypto";

export async function createDualPersistence() {
  const mode = process.env.DUAL_PERSISTENCE_MODE || "local";
  const orgId = process.env.DUAL_ORG_ID || "";
  const templateId = process.env.DUAL_AGENT_PASSPORT_TEMPLATE_ID || "";
  const objectId = process.env.DUAL_AGENT_PASSPORT_OBJECT_ID || "";
  const apiKey = process.env.DUAL_API_KEY || "";
  const serviceAccountToken = process.env.DUAL_SERVICE_ACCOUNT_TOKEN
    || process.env.DUAL_SERVICE_ACCOUNT_BEARER_TOKEN
    || process.env.DUAL_BEARER_TOKEN
    || "";
  const baseUrl = process.env.DUAL_API_URL || "https://gateway-48587430648.europe-west6.run.app";
  const authMode = process.env.DUAL_AUTH_MODE || "api_key";
  const writeMode = process.env.DUAL_WRITE_MODE || (authMode === "api_key" ? "read_only" : "event_bus");

  const config = {
    mode,
    orgId,
    templateId,
    objectId,
    baseUrl,
    authMode,
    writeMode,
    serviceAccountConfigured: Boolean(serviceAccountToken),
    configured: Boolean((apiKey || serviceAccountToken) && orgId && templateId)
  };

  let client = null;
  let serviceAccountClient = null;
  let sessionClient = null;
  let session = null;
  let pendingEmail = null;
  let DualClientClass = null;
  let resolvedEventBusPayloadStyle = process.env.DUAL_EVENTBUS_PAYLOAD_STYLE || "auto";
  let sdkError = null;

  if (mode === "dual") {
    try {
      const { DualClient } = await import("dual-sdk");
      DualClientClass = DualClient;
      if (apiKey && orgId && templateId) {
        client = new DualClient({ baseUrl, token: apiKey, authMode, timeout: 30000 });
      }
      if (serviceAccountToken && orgId && templateId) {
        serviceAccountClient = new DualClient({ baseUrl, token: serviceAccountToken, authMode: "bearer", timeout: 30000 });
      }
    } catch (error) {
      sdkError = error;
    }
  }

  return {
    status() {
      const readClient = activeReadClient();
      const writeClient = activeWriteClient();
      if (mode !== "dual") {
        return {
          mode: "local",
          configured: false,
          available: true,
          detail: "Using local DUAL passport simulator."
        };
      }

      return {
        mode: "dual",
        configured: config.configured,
        available: Boolean(readClient),
        writable: Boolean(writeClient),
        orgId: orgId || null,
        templateId: templateId || null,
        objectId: objectId || null,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        serviceAccount: {
          configured: config.serviceAccountConfigured,
          writable: Boolean(serviceAccountClient && writeMode === "event_bus")
        },
        emailSession: session ? {
          authenticated: true,
          email: maskEmail(session.email),
          orgId: session.orgId || null,
          authenticatedAt: session.authenticatedAt,
          refreshTokenPresent: session.refreshTokenPresent
        } : null,
        detail: client
          ? writeClient
            ? "DUAL persistence adapter is ready for event-bus writes."
            : "DUAL passport is linked for read verification. Event-bus writes need bearer/session auth."
          : serviceAccountClient
            ? writeClient
              ? "DUAL service-account bearer auth is ready for unattended event-bus writes."
              : "DUAL service-account bearer auth is configured; set DUAL_WRITE_MODE=event_bus to enable writes."
          : sessionClient
            ? "DUAL email session is active for event-bus writes."
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
        requiredAuthMode: "bearer",
        requiredWriteMode: "event_bus",
        current: status,
        missing: ready ? [] : [
          ...(status.available || DualClientClass ? [] : ["DUAL SDK/client availability"]),
          ...(activeWriteClient() ? [] : ["email OTP bearer session, DUAL_SERVICE_ACCOUNT_TOKEN, or DUAL_AUTH_MODE=bearer"]),
          ...(effectiveWriteMode() === "event_bus" ? [] : ["DUAL_WRITE_MODE=event_bus or authenticated email session"]),
          "bearer/session/service-account token with /ebus/execute permission"
        ],
        detail: ready
          ? "DUAL event-bus write sync is enabled."
          : "DUAL read-link is active; event-bus write sync needs email-code bearer auth or a service-account bearer token."
      };
    },

    authStatus() {
      const serviceWritable = Boolean(serviceAccountClient && writeMode === "event_bus");
      const envBearerWritable = Boolean(client && authMode === "bearer" && writeMode === "event_bus");
      return {
        enabled: mode === "dual" && Boolean(DualClientClass),
        authenticated: Boolean(sessionClient || serviceWritable || envBearerWritable),
        writable: Boolean(activeWriteClient()),
        authType: sessionClient
          ? "email_session"
          : serviceWritable
            ? "service_account"
            : envBearerWritable
              ? "bearer_env"
              : null,
        serviceAccountConfigured: config.serviceAccountConfigured,
        pendingEmail: pendingEmail ? maskEmail(pendingEmail) : null,
        email: session ? maskEmail(session.email) : null,
        orgId: session?.orgId || null,
        authenticatedAt: session?.authenticatedAt || null,
        detail: sessionClient
          ? "Bearer email session is active for DUAL event-bus writes."
          : serviceWritable
            ? "Service-account bearer auth is active for unattended DUAL event-bus writes."
          : envBearerWritable
            ? "Bearer env auth is active for unattended DUAL event-bus writes."
          : "Request an email code, then verify it to unlock DUAL event-bus writes for this server session."
      };
    },

    async requestEmailCode(email) {
      const normalizedEmail = normalizeEmail(email);
      const loginClient = createBearerClient();
      await loginClient.wallets.requestOtp(normalizedEmail);
      pendingEmail = normalizedEmail;
      return {
        requested: true,
        email: maskEmail(normalizedEmail),
        detail: "Email code requested. Enter the code to create a bearer session."
      };
    },

    async verifyEmailCode(email, code, options = {}) {
      const normalizedEmail = normalizeEmail(email || pendingEmail);
      const otp = String(code || "").trim();
      if (!otp) {
        const error = new Error("Enter the DUAL email code.");
        error.status = 400;
        throw error;
      }

      const loginClient = createBearerClient();
      const tokens = await loginClient.wallets.loginWithOtp(normalizedEmail, otp);
      loginClient.setToken(tokens.access_token);

      let orgTokens = null;
      if (orgId) {
        orgTokens = await loginClient.wallets.switchOrganization(orgId);
        loginClient.setToken(orgTokens.access_token);
      }

      sessionClient = loginClient;
      const activeTokens = orgTokens || tokens;
      session = {
        email: normalizedEmail,
        orgId: orgId || null,
        authenticatedAt: new Date().toISOString(),
        refreshTokenPresent: Boolean(activeTokens.refresh_token)
      };
      pendingEmail = null;
      if (typeof options.onSession === "function") {
        options.onSession({
          token: activeTokens.access_token,
          email: normalizedEmail,
          orgId: session.orgId,
          authenticatedAt: session.authenticatedAt,
          refreshTokenPresent: session.refreshTokenPresent
        });
      }

      return {
        authenticated: true,
        writable: Boolean(activeWriteClient()),
        email: maskEmail(normalizedEmail),
        orgId: session.orgId,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        detail: "Bearer session authenticated. DUAL event-bus replay is ready if this wallet has /ebus/execute permission."
      };
    },

    restoreEmailSession(restoredSession) {
      if (!restoredSession?.token || !restoredSession.email) return false;
      const restoredClient = createBearerClient();
      restoredClient.setToken(restoredSession.token);
      sessionClient = restoredClient;
      session = {
        email: restoredSession.email,
        orgId: restoredSession.orgId || orgId || null,
        authenticatedAt: restoredSession.authenticatedAt || new Date().toISOString(),
        refreshTokenPresent: Boolean(restoredSession.refreshTokenPresent)
      };
      return true;
    },

    async createTemplate() {
      const writeClient = requireWritableClient();
      return writeClient.templates.create(agentTradingPassportTemplatePayload());
    },

    async createActionEnabledPassport(passport) {
      const writeClient = requireWritableClient();
      const template = await writeClient.templates.create(agentTradingPassportTemplatePayload());
      const createdTemplateId = template.id || template.template_id || template.templateId;
      if (!createdTemplateId) {
        const error = new Error("DUAL created a template response without an id.");
        error.status = 502;
        error.body = template;
        throw error;
      }

      const objectProperties = passportProperties(passport, {
        lastEventId: "passport_setup"
      });
      const mintMetadata = {
        source: "kraken_dual_action_passport_setup",
        event_type: "passport_setup",
        event_status: "created"
      };
      const mintResult = await executeEventBusWithFallback(
        writeClient,
        "mint",
        "",
        createdTemplateId,
        orgId,
        objectProperties,
        mintMetadata,
        mintEventBusEnvelope("nested", createdTemplateId, orgId, objectProperties, mintMetadata)
      );
      const object = await findMintedObjectForTemplate(writeClient, createdTemplateId);
      const mintedObjectId = object?.id || object?.object_id || object?.objectId || null;

      return {
        template: summarizeDualTemplate(template),
        object: object ? summarizeDualObject(object) : null,
        mint: summarizeDualResult(mintResult),
        vercelEnv: {
          DUAL_AGENT_PASSPORT_TEMPLATE_ID: createdTemplateId,
          DUAL_AGENT_PASSPORT_OBJECT_ID: mintedObjectId
        },
        next: mintedObjectId
          ? "Update Vercel production env vars to these ids, redeploy, then rerun authenticated DUAL replay."
          : "Mint was accepted, but object search has not indexed the new object yet. Search this template for the minted object before updating Vercel."
      };
    },

    async syncPassport(passport, metadata = {}) {
      const writeClient = requireWritableClient();
      const properties = passportProperties(passport, metadata);
      const envelope = objectId
        ? updateEventBusEnvelope("flat", objectId, templateId, orgId, properties, metadata)
        : mintEventBusEnvelope("flat", templateId, orgId, properties, metadata);
      return executeEventBusWithFallback(writeClient, objectId ? "update" : "mint", objectId, templateId, orgId, properties, metadata, envelope);
    },

    buildReplayQueue(passport, audit = []) {
      const events = audit.map((event) => {
        const envelope = eventBusEnvelope(objectId, templateId, orgId, passport, event);
        const actionId = event.dualSync?.result?.actionId || null;
        return {
          eventId: event.id,
          eventType: event.type,
          eventStatus: event.status,
          eventHash: event.provenanceHash || event.id,
          synced: Boolean(event.dualSync?.synced && actionId),
          actionId,
          ready: Boolean(objectId || templateId),
          envelope,
          envelopeHash: hashJson(envelope)
        };
      });
      const pendingEvents = events.filter((event) => !event.synced);

      return {
        ready: Boolean(objectId || templateId),
        writable: Boolean(activeWriteClient()),
        targetObjectId: objectId || null,
        targetTemplateId: templateId || null,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        eventCount: events.length,
        syncedCount: events.length - pendingEvents.length,
        pendingCount: pendingEvents.length,
        rootHash: hashJson(events.map((event) => ({
          eventId: event.eventId,
          eventHash: event.eventHash,
          actionId: event.actionId,
          envelopeHash: event.envelopeHash
        }))),
        pendingRootHash: hashJson(pendingEvents.map((event) => ({
          eventId: event.eventId,
          eventHash: event.eventHash,
          envelopeHash: event.envelopeHash
        }))),
        events: pendingEvents,
        allEvents: events
      };
    },

    async executeReplayQueue(passport, audit = []) {
      const writeClient = requireWritableClient();
      const replayPassport = await hydratePassportFromDual(passport, activeReadClient(), objectId);
      const replayQueue = this.buildReplayQueue(replayPassport, audit);
      if (!replayQueue.ready) {
        const error = new Error("Replay queue is not ready; configure a DUAL object or template target.");
        error.status = 400;
        throw error;
      }

      const executed = [];
      for (const event of [...replayQueue.events].reverse()) {
        const result = await executeEventBusWithFallback(
          writeClient,
          event.envelope.actionName,
          objectId,
          templateId,
          orgId,
          event.envelope.properties,
          event.envelope.metadata,
          event.envelope.payload
        );
        executed.push({
          eventId: event.eventId,
          eventType: event.eventType,
          eventStatus: event.eventStatus,
          eventHash: event.eventHash,
          envelopeHash: event.envelopeHash,
          result: summarizeDualResult(result)
        });
      }

      return {
        executed: true,
        executedCount: executed.length,
        skippedCount: replayQueue.syncedCount,
        replayRoot: replayQueue.rootHash,
        pendingReplayRoot: replayQueue.pendingRootHash,
        targetObjectId: replayQueue.targetObjectId,
        targetTemplateId: replayQueue.targetTemplateId,
        events: executed
      };
    },

    async readPassportObject() {
      const readClient = activeReadClient();
      if (!readClient || !objectId) {
        return {
          available: false,
          reason: objectId ? this.status().detail : "Set DUAL_AGENT_PASSPORT_OBJECT_ID."
        };
      }

      const object = await readClient.objects.get(objectId);
      return {
        available: true,
        id: object.id,
        templateId: object.template_id || object.templateId || null,
        orgId: object.org_id || object.organization_id || null,
        owner: object.owner || object.owner_id || null,
        custom: object.custom || object.properties || {},
        integrityHash: object.integrity_hash || object.integrityHash || null,
        stateHash: object.state_hash || object.stateHash || null,
        whenModified: object.when_modified || object.updated_at || object.updatedAt || null
      };
    },

    async readPassportTemplate() {
      const readClient = activeReadClient();
      if (!readClient || !templateId) {
        return {
          available: false,
          reason: templateId ? this.status().detail : "Set DUAL_AGENT_PASSPORT_TEMPLATE_ID."
        };
      }

      const template = await readClient.templates.get(templateId);
      return {
        available: true,
        id: template.id,
        name: template.name,
        custom: template.object?.custom || template.properties || {},
        publicAccess: template.public_access || template.publicAccess || null,
        whenModified: template.when_modified || template.updated_at || template.updatedAt || null
      };
    },

    async readLatestBatchProof() {
      const readClient = activeReadClient();
      if (!readClient?.sequencer?.listBatches) {
        return {
          available: false,
          reason: readClient ? "DUAL sequencer batch API is unavailable in this SDK/runtime." : this.status().detail
        };
      }

      const response = await readClient.sequencer.listBatches({ limit: 10 });
      const batches = extractItems(response).map(summarizeDualBatch).filter(Boolean);
      const latest = batches[0] || null;
      if (!latest?.id) {
        return {
          available: false,
          reason: "No DUAL sequencer batches were returned for this credential."
        };
      }

      let detail = latest;
      if (readClient.sequencer.getBatch) {
        try {
          detail = summarizeDualBatch(unwrapBatch(await readClient.sequencer.getBatch(latest.id))) || latest;
        } catch {
          detail = latest;
        }
      }

      return {
        available: true,
        ...detail,
        finality: describeBatchFinality(detail)
      };
    },

    async recordEvent(passport, event) {
      const writeClient = activeWriteClient();
      if (!activeReadClient()) return { skipped: true, reason: this.status().detail };
      const envelope = eventBusEnvelope(objectId, templateId, orgId, passport, event);
      if (!writeClient) {
        return {
          skipped: true,
          reason: "DUAL event-bus writes require email-code bearer auth or service-account bearer auth; current deployment is read-linked.",
          replay: {
            envelope,
            envelopeHash: hashJson(envelope)
          }
        };
      }

      const result = await executeEventBusWithFallback(
        writeClient,
        envelope.actionName,
        objectId,
        templateId,
        orgId,
        envelope.properties,
        envelope.metadata,
        envelope.payload
      );
      return {
        synced: true,
        envelopeHash: hashJson(envelope.payload),
        result: summarizeDualResult(result)
      };
    },

    async probeUpdateSchemas(passport) {
      const writeClient = requireWritableClient();
      const properties = passportProperties(passport, { lastEventId: "schema_probe" });
      const probes = updateSchemaProbePayloads(objectId, properties);
      const results = [];
      for (const probe of probes) {
        try {
          const result = probe.kind === "object_update"
            ? await writeClient.objects.update(objectId, probe.payload)
            : await writeClient.eventBus.execute(probe.payload);
          results.push({
            name: probe.name,
            ok: true,
            result: probe.kind === "object_update" ? summarizeDualObject(result) : summarizeDualResult(result)
          });
        } catch (error) {
          results.push({
            name: probe.name,
            ok: false,
            error: summarizeDualError(probe.name, error)
          });
        }
      }
      return {
        targetObjectId: objectId,
        targetTemplateId: templateId,
        results
      };
    }
  };

  function activeReadClient() {
    return sessionClient || client || serviceAccountClient;
  }

  function activeWriteClient() {
    if (sessionClient) return sessionClient;
    if (serviceAccountClient && writeMode === "event_bus") return serviceAccountClient;
    if (client && authMode === "bearer" && writeMode === "event_bus") return client;
    return null;
  }

  function effectiveAuthMode() {
    if (sessionClient) return "bearer_email_session";
    if (serviceAccountClient) return "bearer_service_account";
    return authMode;
  }

  function effectiveWriteMode() {
    return activeWriteClient() ? "event_bus" : writeMode;
  }

  function createBearerClient() {
    if (!DualClientClass) {
      const error = new Error(sdkError ? `DUAL SDK unavailable: ${sdkError.message}` : "DUAL SDK is unavailable in this runtime.");
      error.status = 400;
      throw error;
    }
    return new DualClientClass({ baseUrl, authMode: "bearer", timeout: 30000 });
  }

  function requireWritableClient() {
    const writeClient = activeWriteClient();
    if (writeClient) return writeClient;
    const error = new Error("DUAL event-bus writes require an authenticated email-code bearer session or DUAL_AUTH_MODE=bearer with DUAL_WRITE_MODE=event_bus.");
    error.status = 400;
    throw error;
  }

  async function executeEventBusWithFallback(writeClient, actionName, objectId, templateId, orgId, properties, metadata, preferredPayload) {
    const attempts = eventBusPayloadAttempts(actionName, objectId, templateId, orgId, properties, metadata, preferredPayload);
    const errors = [];
    for (const attempt of attempts) {
      try {
        const result = await writeClient.eventBus.execute(attempt.payload);
        resolvedEventBusPayloadStyle = attempt.style;
        return {
          ...summarizeDualResult(result),
          raw: result,
          payloadStyle: attempt.style
        };
      } catch (error) {
        errors.push(summarizeDualError(attempt.style, error));
      }
    }
    const summary = errors.map((item) => `${item.style}: ${item.message}`).join("; ");
    const error = new Error(`DUAL event-bus execute failed. ${summary}`);
    error.status = errors[0]?.status || 400;
    error.body = { attempts: errors };
    throw error;
  }

  function eventBusPayloadAttempts(actionName, objectId, templateId, orgId, properties, metadata, preferredPayload) {
    const styles = resolvedEventBusPayloadStyle === "auto"
      ? ["nested_data_custom", "nested_data_public", "flat", "nested", "top_level_custom", "top_level_public", "top_level_custom_public", "top_level_payload", "top_level_payload_custom", "top_level_payload_public", "nested_payload", "nested_payload_custom", "nested_payload_public", "nested_customData", "nested_publicData", "top_level_custom_data", "top_level_public_data", "object_id_custom", "object_id_custom_data", "nested_custom_data", "nested_public_data", "nested_object_custom", "nested_public", "nested_custom_public", "named", "classic_object", "classic_custom"]
      : [resolvedEventBusPayloadStyle];
    return styles.map((style) => ({
      style,
      payload: actionName === "update"
        ? updateEventBusEnvelope(style, objectId, templateId, orgId, properties, metadata)
        : mintEventBusEnvelope(style, templateId, orgId, properties, metadata)
    })).filter((attempt, index, attempts) => {
      if (!preferredPayload || index > 0) return true;
      return hashJson(attempt.payload) !== hashJson(preferredPayload) || attempts.findIndex((item) => hashJson(item.payload) === hashJson(preferredPayload)) === index;
    });
  }
}

function requireClient(client, config) {
  if (client) return;
  const error = new Error(config.configured
    ? "DUAL SDK is unavailable. Install/configure dual-sdk in this runtime."
    : "DUAL persistence requires DUAL_API_KEY, DUAL_ORG_ID, and DUAL_AGENT_PASSPORT_TEMPLATE_ID.");
  error.status = 400;
  throw error;
}

function requireWritable(config) {
  if (config.writeMode === "event_bus") return;
  const error = new Error("This deployment is linked to a real DUAL passport, but write-sync requires bearer/session auth. Set DUAL_AUTH_MODE=bearer and DUAL_WRITE_MODE=event_bus with a suitable token to enable writes.");
  error.status = 400;
  throw error;
}

function passportProperties(passport, metadata = {}) {
  return {
    passport_id: passport.id,
    agent_name: passport.agentName,
    mode: passport.mode,
    state: passport.dualObjectState || passport.state,
    allowed_pairs: passport.allowedPairs,
    max_notional_usd: String(passport.maxNotionalUsd),
    max_daily_notional_usd: String(passport.maxDailyNotionalUsd),
    daily_notional_used: String(passport.dailyNotionalUsed),
    leverage_allowed: String(passport.leverageAllowed),
    human_approval_required_above: String(passport.humanApprovalRequiredAbove),
    blocked_actions: passport.blockedActions,
    approval_policy: passport.approvalPolicy,
    policy_version: String(passport.policyVersion || 1),
    policy_hash: passport.policyHash || policyHashFromPassport(passport),
    owner_wallet: passport.ownerWallet,
    last_event_id: metadata.lastEventId || ""
  };
}

function policyHashFromPassport(passport) {
  return hashJson({
    allowedPairs: passport.allowedPairs,
    maxNotionalUsd: passport.maxNotionalUsd,
    maxDailyNotionalUsd: passport.maxDailyNotionalUsd,
    leverageAllowed: passport.leverageAllowed,
    humanApprovalRequiredAbove: passport.humanApprovalRequiredAbove,
    blockedActions: passport.blockedActions,
    approvalPolicy: passport.approvalPolicy,
    policyVersion: passport.policyVersion || 1
  });
}

async function hydratePassportFromDual(passport, readClient, objectId) {
  if (!readClient || !objectId) return passport;
  try {
    const object = await readClient.objects.get(objectId);
    const custom = object.custom || object.properties || {};
    if (!custom.passport_id) return passport;
    return {
      ...passport,
      id: custom.passport_id || passport.id,
      agentName: custom.agent_name || passport.agentName,
      mode: custom.mode || passport.mode,
      dualObjectState: custom.state || passport.dualObjectState || passport.state,
      allowedPairs: Array.isArray(custom.allowed_pairs) ? custom.allowed_pairs : passport.allowedPairs,
      maxNotionalUsd: numberFromCustom(custom.max_notional_usd, passport.maxNotionalUsd),
      maxDailyNotionalUsd: numberFromCustom(custom.max_daily_notional_usd, passport.maxDailyNotionalUsd),
      dailyNotionalUsed: numberFromCustom(custom.daily_notional_used, passport.dailyNotionalUsed),
      leverageAllowed: booleanFromCustom(custom.leverage_allowed, passport.leverageAllowed),
      humanApprovalRequiredAbove: numberFromCustom(custom.human_approval_required_above, passport.humanApprovalRequiredAbove),
      blockedActions: Array.isArray(custom.blocked_actions) ? custom.blocked_actions : passport.blockedActions,
      approvalPolicy: custom.approval_policy || passport.approvalPolicy,
      policyVersion: numberFromCustom(custom.policy_version, passport.policyVersion || 1),
      policyHash: custom.policy_hash || passport.policyHash,
      ownerWallet: custom.owner_wallet || passport.ownerWallet
    };
  } catch {
    return passport;
  }
}

function numberFromCustom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanFromCustom(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function agentTradingPassportProperties() {
  return {
    passport_id: "string",
    agent_name: "string",
    mode: "string",
    state: "string",
    allowed_pairs: "array",
    max_notional_usd: "string",
    max_daily_notional_usd: "string",
    daily_notional_used: "string",
    leverage_allowed: "string",
    human_approval_required_above: "string",
    blocked_actions: "array",
    approval_policy: "string",
    policy_version: "string",
    policy_hash: "string",
    owner_wallet: "string",
    last_event_id: "string",
    last_event_type: "string",
    last_event_status: "string",
    last_event_hash: "string",
    last_event_at: "string"
  };
}

function agentTradingPassportTemplatePayload() {
  const custom = agentTradingPassportProperties();
  const publicFields = Object.keys(custom);
  const version = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return {
    name: `io.dual.kraken.agent_trading_passport.action_enabled.${version}`,
    description: "Policy-bound agent passport for Kraken paper/live trading governance.",
    organization_id: process.env.DUAL_ORG_ID || undefined,
    organizationId: process.env.DUAL_ORG_ID || undefined,
    properties: custom,
    object: {
      metadata: {
        name: "Kraken Market Agent Passport",
        description: "A DUAL-governed trading-agent passport for Kraken market data, mandate checks, paper execution, and event replay.",
        category: "agent-commerce-trading-passport",
        integration: "kraken-dual-agent-demo",
        demo_mode: "paper"
      },
      custom
    },
    actions: [
      { name: "mint", alias: "issue_kraken_agent_passport" },
      { name: "update", alias: "record_kraken_agent_event" }
    ],
    public_access: {
      custom: publicFields
    }
  };
}

function eventBusEnvelope(objectId, templateId, orgId, passport, event) {
  const properties = {
    ...passportProperties(passport, { lastEventId: event.id }),
    last_event_id: event.id,
    last_event_type: event.type,
    last_event_status: event.status,
    last_event_hash: event.provenanceHash || event.id,
    last_event_at: event.timestamp
  };

  const metadata = {
    event_id: event.id,
    event_type: event.type,
    event_status: event.status,
    event_hash: event.provenanceHash,
    event_payload: event.payload || {}
  };

  if (objectId) {
    return {
      properties,
      metadata,
      actionName: "update",
      payload: updateEventBusEnvelope("nested_data_custom", objectId, templateId, orgId, properties, metadata)
    };
  }

  return {
    properties,
    metadata,
    actionName: "mint",
    payload: mintEventBusEnvelope("flat", templateId, orgId, properties, metadata)
  };
}

function updateEventBusEnvelope(style, objectId, templateId, orgId, properties, metadata) {
  if (style === "nested_data_custom") {
    return {
      action: {
        update: {
          id: objectId,
          data: {
            custom: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "nested_data_public") {
    return {
      action: {
        update: {
          id: objectId,
          data: {
            public: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "nested") {
    return {
      action: {
        update: {
          id: objectId,
          custom: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_object_custom") {
    return {
      action: {
        update: {
          id: objectId,
          object: {
            custom: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "top_level_custom") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      custom: properties,
      metadata
    };
  }
  if (style === "top_level_public") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      public: properties,
      metadata
    };
  }
  if (style === "top_level_custom_public") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      custom: properties,
      public: properties,
      metadata
    };
  }
  if (style === "top_level_payload") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      payload: properties,
      metadata
    };
  }
  if (style === "top_level_payload_custom") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      payload: {
        custom: properties
      },
      metadata
    };
  }
  if (style === "top_level_payload_public") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      payload: {
        public: properties
      },
      metadata
    };
  }
  if (style === "nested_payload") {
    return {
      action: {
        update: {
          id: objectId,
          payload: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_payload_custom") {
    return {
      action: {
        update: {
          id: objectId,
          payload: {
            custom: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "nested_payload_public") {
    return {
      action: {
        update: {
          id: objectId,
          payload: {
            public: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "nested_customData") {
    return {
      action: {
        update: {
          id: objectId,
          customData: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_publicData") {
    return {
      action: {
        update: {
          id: objectId,
          publicData: properties
        }
      },
      metadata
    };
  }
  if (style === "top_level_custom_data") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      custom_data: properties,
      metadata
    };
  }
  if (style === "top_level_public_data") {
    return {
      action: {
        update: {
          id: objectId
        }
      },
      public_data: properties,
      metadata
    };
  }
  if (style === "object_id_custom") {
    return {
      action: {
        update: {
          object_id: objectId
        }
      },
      custom: properties,
      metadata
    };
  }
  if (style === "object_id_custom_data") {
    return {
      action: {
        update: {
          object_id: objectId
        }
      },
      custom_data: properties,
      metadata
    };
  }
  if (style === "nested_custom_data") {
    return {
      action: {
        update: {
          id: objectId,
          custom_data: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_public_data") {
    return {
      action: {
        update: {
          id: objectId,
          public_data: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_public") {
    return {
      action: {
        update: {
          id: objectId,
          public: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_custom_public") {
    return {
      action: {
        update: {
          id: objectId,
          custom: properties,
          public: properties
        }
      },
      metadata
    };
  }
  if (style === "named") {
    return {
      action: {
        name: "update",
        template_id: templateId,
        object_id: objectId,
        properties
      },
      metadata
    };
  }
  if (style === "classic_object") {
    return {
      this: objectId,
      action: "update",
      object: {
        custom: properties
      },
      metadata
    };
  }
  if (style === "classic_custom") {
    return {
      this: objectId,
      action: "update",
      custom: properties,
      metadata
    };
  }
  return {
    action: "update",
    organizationId: orgId,
    objectId,
    properties,
    metadata
  };
}

function updateSchemaProbePayloads(objectId, properties) {
  return [
    { kind: "object_update", name: "object_update_properties", payload: { properties } },
    { kind: "object_update", name: "object_update_custom", payload: { custom: properties } },
    { kind: "object_update", name: "object_update_object_custom", payload: { object: { custom: properties } } },
    { kind: "event_bus", name: "update_customData", payload: { action: { update: { id: objectId, customData: properties } } } },
    { kind: "event_bus", name: "update_publicData", payload: { action: { update: { id: objectId, publicData: properties } } } },
    { kind: "event_bus", name: "update_custom_json", payload: { action: { update: { id: objectId, custom_json: properties } } } },
    { kind: "event_bus", name: "update_public_json", payload: { action: { update: { id: objectId, public_json: properties } } } },
    { kind: "event_bus", name: "update_data_custom", payload: { action: { update: { id: objectId, data: { custom: properties } } } } },
    { kind: "event_bus", name: "update_data_public", payload: { action: { update: { id: objectId, data: { public: properties } } } } },
    { kind: "event_bus", name: "update_object_custom_top", payload: { action: { update: { id: objectId } }, object: { custom: properties } } },
    { kind: "event_bus", name: "update_object_public_top", payload: { action: { update: { id: objectId } }, object: { public: properties } } },
    { kind: "event_bus", name: "update_with_custom_root", payload: { action: { update: { id: objectId } }, custom: properties } },
    { kind: "event_bus", name: "update_with_public_root", payload: { action: { update: { id: objectId } }, public: properties } },
    { kind: "event_bus", name: "update_with_customData_root", payload: { action: { update: { id: objectId } }, customData: properties } },
    { kind: "event_bus", name: "update_with_publicData_root", payload: { action: { update: { id: objectId } }, publicData: properties } },
    { kind: "event_bus", name: "update_custom_empty_metadata", payload: { action: { update: { id: objectId, custom: properties } }, metadata: {} } },
    { kind: "event_bus", name: "update_public_empty_metadata", payload: { action: { update: { id: objectId, public: properties } }, metadata: {} } }
  ];
}

function mintEventBusEnvelope(style, templateId, orgId, properties, metadata) {
  if (style === "nested") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          custom: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_object_custom") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          object: {
            custom: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "top_level_custom") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      custom: properties,
      metadata
    };
  }
  if (style === "top_level_public") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      public: properties,
      metadata
    };
  }
  if (style === "top_level_custom_public") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      custom: properties,
      public: properties,
      metadata
    };
  }
  if (style === "top_level_payload") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      payload: properties,
      metadata
    };
  }
  if (style === "top_level_payload_custom") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      payload: {
        custom: properties
      },
      metadata
    };
  }
  if (style === "top_level_payload_public") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      payload: {
        public: properties
      },
      metadata
    };
  }
  if (style === "nested_payload") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          payload: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_payload_custom") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          payload: {
            custom: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "nested_payload_public") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          payload: {
            public: properties
          }
        }
      },
      metadata
    };
  }
  if (style === "nested_customData") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          customData: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_publicData") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          publicData: properties
        }
      },
      metadata
    };
  }
  if (style === "top_level_custom_data") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      custom_data: properties,
      metadata
    };
  }
  if (style === "top_level_public_data") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1
        }
      },
      public_data: properties,
      metadata
    };
  }
  if (style === "object_id_custom" || style === "object_id_custom_data") {
    return mintEventBusEnvelope(style === "object_id_custom" ? "top_level_custom" : "top_level_custom_data", templateId, orgId, properties, metadata);
  }
  if (style === "nested_custom_data") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          custom_data: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_public_data") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          public_data: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_public") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          public: properties
        }
      },
      metadata
    };
  }
  if (style === "nested_custom_public") {
    return {
      action: {
        mint: {
          template_id: templateId,
          num: 1,
          custom: properties,
          public: properties
        }
      },
      metadata
    };
  }
  if (style === "named") {
    return {
      action: {
        name: "mint",
        template_id: templateId,
        properties
      },
      metadata
    };
  }
  return {
    action: "mint",
    organizationId: orgId,
    templateId,
    properties,
    metadata
  };
}

function summarizeDualResult(result) {
  if (!result || typeof result !== "object") return result || null;
  return {
    id: result.id || result.object_id || result.objectId || result.event_id || result.eventId || null,
    status: result.status || result.state || null,
    hash: result.hash || result.integrity_hash || result.integrityHash || result.state_hash || result.stateHash || null,
    actionId: result.action_id || result.actionId || null,
    batchId: result.batch_id || result.batchId || null,
    payloadStyle: result.payloadStyle || null
  };
}

function summarizeDualBatch(batch) {
  if (!batch || typeof batch !== "object") return null;
  return {
    id: batch.id || batch.batch_id || batch.batchId || null,
    status: batch.status || batch.state || null,
    proofValue: batch.proof_value || batch.proofValue || batch.proof?.value || batch.proof?.status || null,
    actionCount: batch.action_count ?? batch.actions_count ?? batch.actionCount ?? batch.actions?.length ?? batch.affected_actions?.length ?? null,
    merkleRoot: batch.merkle_root || batch.merkleRoot || batch.root_hash || batch.rootHash || null,
    checkpointId: batch.checkpoint_id || batch.checkpointId || batch.checkpoint?.id || null,
    transactionHash: nonZeroHash(batch.transaction_hash || batch.transactionHash || batch.tx_hash || batch.txHash || batch.l1_tx_hash || batch.l1TxHash || batch.l2_finalization_tx_hash || batch.l2FinalizationTxHash || batch.l2_tx_hash || batch.l2TxHash),
    chainId: batch.chain_id || batch.chainId || batch.network || batch.chain || null,
    createdAt: batch.created_at || batch.createdAt || batch.when_created || batch.whenCreated || null,
    updatedAt: batch.updated_at || batch.updatedAt || batch.when_modified || batch.whenModified || null
  };
}

function extractItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.batches)) return response.batches;
  if (Array.isArray(response?.data?.batches)) return response.data.batches;
  if (Array.isArray(response?.data?.items)) return response.data.items;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.results)) return response.results;
  return [];
}

function unwrapBatch(response) {
  return response?.data?.batch || response?.data || response?.batch || response;
}

function describeBatchFinality(batch) {
  const status = String(batch?.status || "").toLowerCase();
  const proofValue = String(batch?.proofValue || "").toLowerCase();
  const hasL1Hash = Boolean(batch?.transactionHash);
  if (/final|confirmed|complete|completed|anchored/.test(status) || hasL1Hash) {
    return "finalized";
  }
  if (proofValue === "success" || status === "anchoring") {
    return "proof-success";
  }
  if (/fail|error|reject/.test(status) || /fail|error|reject/.test(proofValue)) {
    return "failed";
  }
  return status || proofValue ? "pending" : "unknown";
}

function nonZeroHash(value) {
  const text = String(value || "");
  if (!text) return null;
  if (/^0x0+$/.test(text)) return null;
  return text;
}

function summarizeDualTemplate(template) {
  if (!template || typeof template !== "object") return template || null;
  return {
    id: template.id || template.template_id || template.templateId || null,
    name: template.name || null,
    actions: template.actions || null,
    publicAccess: template.public_access || template.publicAccess || null
  };
}

function summarizeDualObject(object) {
  if (!object || typeof object !== "object") return object || null;
  return {
    id: object.id || object.object_id || object.objectId || null,
    templateId: object.template_id || object.templateId || null,
    owner: object.owner || object.owner_id || null,
    custom: object.custom || object.properties || null,
    integrityHash: object.integrity_hash || object.integrityHash || null,
    stateHash: object.state_hash || object.stateHash || null
  };
}

async function findMintedObjectForTemplate(writeClient, templateId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const object = await searchObjectsByTemplate(writeClient, templateId);
    if (object) return object;
    await delay(750);
  }
  return null;
}

async function searchObjectsByTemplate(writeClient, templateId) {
  try {
    const result = await writeClient.objects.search({ template_id: templateId });
    const items = normalizeItems(result);
    if (items.length) return newestObject(items);
  } catch {
    // Some gateways expose template filtering only on list.
  }

  try {
    const result = await writeClient.objects.list({ template_id: templateId, limit: 10 });
    const items = normalizeItems(result);
    if (items.length) return newestObject(items);
  } catch {
    return null;
  }

  return null;
}

function normalizeItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.objects)) return result.objects;
  return [];
}

function newestObject(items) {
  return [...items].sort((a, b) => String(b.when_created || b.created_at || b.createdAt || "").localeCompare(String(a.when_created || a.created_at || a.createdAt || "")))[0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeDualError(style, error) {
  return {
    style,
    message: error?.message || "Unknown DUAL event-bus error",
    code: error?.code || error?.name || null,
    status: error?.status || error?.statusCode || null,
    body: sanitizeDualErrorBody(error?.body)
  };
}

function sanitizeDualErrorBody(body) {
  if (!body || typeof body !== "object") return body || null;
  return JSON.parse(JSON.stringify(body, (key, value) => {
    if (/token|secret|key|auth|password/i.test(key)) return "[REDACTED]";
    return value;
  }));
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
  if (!name || !domain) return null;
  return `${name.slice(0, 2)}***@${domain}`;
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
