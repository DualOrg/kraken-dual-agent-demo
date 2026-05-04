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
  let sdkError = null;

  if (mode === "dual" && config.configured) {
    try {
      const { DualClient } = await import("dual-sdk");
      client = new DualClient({ baseUrl, token: apiKey, authMode, timeout: 30000 });
    } catch (error) {
      sdkError = error;
    }
  }

  return {
    status() {
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
        available: Boolean(client),
        writable: Boolean(client && writeMode === "event_bus"),
        orgId: orgId || null,
        templateId: templateId || null,
        objectId: objectId || null,
        authMode,
        writeMode,
        detail: client
          ? writeMode === "event_bus"
            ? "DUAL persistence adapter is ready for event-bus writes."
            : "DUAL passport is linked for read verification. Event-bus writes need bearer/session auth."
          : sdkError
            ? `DUAL SDK unavailable: ${sdkError.message}`
            : "Set DUAL_API_KEY, DUAL_ORG_ID, and DUAL_AGENT_PASSPORT_TEMPLATE_ID."
      };
    },

    async createTemplate() {
      requireClient(client, config);
      requireWritable(config);
      return client.templates.create({
        name: "io.dual.kraken.agent_trading_passport",
        description: "Policy-bound agent passport for Kraken paper/live trading governance.",
        properties: agentTradingPassportProperties()
      });
    },

    async syncPassport(passport, metadata = {}) {
      requireClient(client, config);
      requireWritable(config);
      const properties = passportProperties(passport, metadata);

      if (objectId) {
        return client.eventBus.execute({
          action: {
            update: {
              id: objectId,
              custom: properties
            }
          },
          metadata
        });
      }

      return client.eventBus.execute({
        action: {
          mint: {
            template_id: templateId,
            custom: properties
          }
        },
        metadata
      });
    },

    async recordEvent(passport, event) {
      if (!client) return { skipped: true, reason: this.status().detail };
      if (writeMode !== "event_bus") {
        return { skipped: true, reason: "DUAL event-bus writes require bearer/session auth; current deployment is read-linked." };
      }

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
        return client.eventBus.execute({
          action: {
            update: {
              id: objectId,
              custom: properties
            }
          },
          metadata
        });
      }

      return client.eventBus.execute({
        action: {
          mint: {
            template_id: templateId,
            custom: properties
          }
        },
        metadata
      });
    }
  };
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
