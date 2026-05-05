import crypto from "node:crypto";

export async function createDualPersistence() {
  const mode = process.env.DUAL_PERSISTENCE_MODE || "local";
  const orgId = process.env.DUAL_ORG_ID || "";
  const templateId = process.env.DUAL_AGENT_PASSPORT_TEMPLATE_ID || "";
  const objectId = process.env.DUAL_AGENT_PASSPORT_OBJECT_ID || "";
  const apiKey = process.env.DUAL_API_KEY || "";
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
    configured: Boolean(apiKey && orgId && templateId)
  };

  let client = null;
  let sessionClient = null;
  let session = null;
  let pendingEmail = null;
  let DualClientClass = null;
  let sdkError = null;

  if (mode === "dual") {
    try {
      const { DualClient } = await import("dual-sdk");
      DualClientClass = DualClient;
      if (config.configured) {
        client = new DualClient({ baseUrl, token: apiKey, authMode, timeout: 30000 });
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
          ...(sessionClient ? [] : ["email OTP bearer session or DUAL_AUTH_MODE=bearer"]),
          ...(effectiveWriteMode() === "event_bus" ? [] : ["DUAL_WRITE_MODE=event_bus or authenticated email session"]),
          "bearer/session/service-account token with /ebus/execute permission"
        ],
        detail: ready
          ? "DUAL event-bus write sync is enabled."
          : "DUAL read-link is active; event-bus write sync needs email-code bearer auth or a service-account bearer token."
      };
    },

    authStatus() {
      return {
        enabled: mode === "dual" && Boolean(DualClientClass),
        authenticated: Boolean(sessionClient),
        writable: Boolean(activeWriteClient()),
        pendingEmail: pendingEmail ? maskEmail(pendingEmail) : null,
        email: session ? maskEmail(session.email) : null,
        orgId: session?.orgId || null,
        authenticatedAt: session?.authenticatedAt || null,
        detail: sessionClient
          ? "Bearer email session is active for DUAL event-bus writes."
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
      return writeClient.templates.create({
        name: "io.dual.kraken.agent_trading_passport",
        description: "Policy-bound agent passport for Kraken paper/live trading governance.",
        properties: agentTradingPassportProperties()
      });
    },

    async syncPassport(passport, metadata = {}) {
      const writeClient = requireWritableClient();
      const properties = passportProperties(passport, metadata);

      if (objectId) {
        return writeClient.eventBus.execute({
          action: "update",
          organizationId: orgId,
          objectId,
          properties,
          metadata
        });
      }

      return writeClient.eventBus.execute({
        action: "mint",
        organizationId: orgId,
        templateId,
        properties,
        metadata
      });
    },

    buildReplayQueue(passport, audit = []) {
      const events = audit.map((event) => {
        const envelope = eventBusEnvelope(objectId, templateId, orgId, passport, event);
        return {
          eventId: event.id,
          eventType: event.type,
          eventStatus: event.status,
          eventHash: event.provenanceHash || event.id,
          ready: Boolean(objectId || templateId),
          envelope,
          envelopeHash: hashJson(envelope)
        };
      });

      return {
        ready: Boolean(objectId || templateId),
        writable: Boolean(activeWriteClient()),
        targetObjectId: objectId || null,
        targetTemplateId: templateId || null,
        authMode: effectiveAuthMode(),
        writeMode: effectiveWriteMode(),
        eventCount: events.length,
        rootHash: hashJson(events.map((event) => ({
          eventId: event.eventId,
          eventHash: event.eventHash,
          envelopeHash: event.envelopeHash
        }))),
        events
      };
    },

    async executeReplayQueue(passport, audit = []) {
      const writeClient = requireWritableClient();
      const replayQueue = this.buildReplayQueue(passport, audit);
      if (!replayQueue.ready) {
        const error = new Error("Replay queue is not ready; configure a DUAL object or template target.");
        error.status = 400;
        throw error;
      }

      const executed = [];
      for (const event of [...replayQueue.events].reverse()) {
        const result = await writeClient.eventBus.execute(event.envelope);
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
        replayRoot: replayQueue.rootHash,
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

      const result = await writeClient.eventBus.execute(envelope);
      return {
        synced: true,
        envelopeHash: hashJson(envelope),
        result: summarizeDualResult(result)
      };
    }
  };

  function activeReadClient() {
    return sessionClient || client;
  }

  function activeWriteClient() {
    if (sessionClient) return sessionClient;
    if (client && authMode === "bearer" && writeMode === "event_bus") return client;
    return null;
  }

  function effectiveAuthMode() {
    return sessionClient ? "bearer_email_session" : authMode;
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
    owner_wallet: passport.ownerWallet,
    last_event_id: metadata.lastEventId || ""
  };
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
    owner_wallet: "string",
    last_event_id: "string",
    last_event_type: "string",
    last_event_status: "string",
    last_event_hash: "string",
    last_event_at: "string"
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
      action: "update",
      organizationId: orgId,
      objectId,
      properties,
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
    actionId: result.action_id || result.actionId || null
  };
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
