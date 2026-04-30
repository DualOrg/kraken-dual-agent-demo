export async function createDualPersistence() {
  const mode = process.env.DUAL_PERSISTENCE_MODE || "local";
  const orgId = process.env.DUAL_ORG_ID || "";
  const templateId = process.env.DUAL_AGENT_PASSPORT_TEMPLATE_ID || "";
  const objectId = process.env.DUAL_AGENT_PASSPORT_OBJECT_ID || "";
  const apiKey = process.env.DUAL_API_KEY || "";
  const baseUrl = process.env.DUAL_API_URL || "https://gateway-48587430648.europe-west6.run.app";

  const config = {
    mode,
    orgId,
    templateId,
    objectId,
    baseUrl,
    configured: Boolean(apiKey && orgId && templateId)
  };

  let client = null;
  let sdkError = null;

  if (mode === "dual" && config.configured) {
    try {
      const { DualClient } = await import("dual-sdk");
      client = new DualClient({ baseUrl, apiKey, timeout: 30000 });
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
        orgId: orgId || null,
        templateId: templateId || null,
        objectId: objectId || null,
        detail: client
          ? "DUAL persistence adapter is ready."
          : sdkError
            ? `DUAL SDK unavailable: ${sdkError.message}`
            : "Set DUAL_API_KEY, DUAL_ORG_ID, and DUAL_AGENT_PASSPORT_TEMPLATE_ID."
      };
    },

    async createTemplate() {
      requireClient(client, config);
      return client.templates.create({
        organizationId: orgId,
        name: "io.dual.kraken.agent_trading_passport",
        description: "Policy-bound agent passport for Kraken paper/live trading governance.",
        properties: agentTradingPassportProperties()
      });
    },

    async syncPassport(passport, metadata = {}) {
      requireClient(client, config);
      const properties = passportProperties(passport, metadata);

      if (objectId) {
        return client.eventBus.execute({
          action: "update",
          organizationId: orgId,
          objectId,
          properties,
          metadata
        });
      }

      return client.eventBus.execute({
        action: "mint",
        organizationId: orgId,
        templateId,
        properties,
        metadata
      });
    },

    async recordEvent(passport, event) {
      if (!client) return { skipped: true, reason: this.status().detail };

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
          action: event.type || "update",
          organizationId: orgId,
          objectId,
          properties,
          metadata
        });
      }

      return client.eventBus.execute({
        action: "mint",
        organizationId: orgId,
        templateId,
        properties,
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
