import { createDualPersistence, dualNetworkConfig, networkMigrationPreflight } from "../src/dualPersistenceV3.mjs";

const ENV_KEYS = [
  "DUAL_NETWORK",
  "KRAKEN_DUAL_NETWORK",
  "KRAKEN_MAINNET_CUTOVER_CONFIRMED",
  "DUAL_MAINNET_CUTOVER_CONFIRMED",
  "DUAL_API_URL",
  "DUAL_CONSOLE_BASE_URL",
  "DUAL_L3_EXPLORER_BASE_URL",
  "DUAL_L2_EXPLORER_BASE_URL",
  "DUAL_BLOCKSCOUT_BASE_URL",
  "DUAL_L1_EXPLORER_BASE_URL",
  "DUAL_API_KEY",
  "DUAL_ORG_ID",
  "DUAL_AGENT_PASSPORT_TEMPLATE_ID",
  "DUAL_AGENT_PASSPORT_OBJECT_ID",
  "DUAL_TRADE_RECEIPT_TEMPLATE_ID",
  "DUAL_WRITE_MODE",
  "DUAL_PERSISTENCE_MODE",
  "DEMO_PUBLIC_DUAL_WRITES",
  "DUAL_AUTH_MODE",
  "DUAL_SERVICE_ACCOUNT_TOKEN",
  "DUAL_SERVICE_ACCOUNT_BEARER_TOKEN",
  "DUAL_BEARER_TOKEN",
  "DUAL_SERVICE_ACCOUNT_REFRESH_TOKEN",
  "DUAL_SERVICE_ACCOUNT_AUTH_MODE",
  "DUAL_EVENTBUS_WRITE_PATH"
];

const results = [];

await scenario("default_testnet_mode_is_not_a_mainnet_claim", {}, async () => {
  const config = dualNetworkConfig();
  const preflight = networkMigrationPreflight(config);
  const persistence = await createDualPersistence();
  const status = persistence.status();

  assert(preflight.ready, "default testnet config should pass local network preflight");
  assert(preflight.target_network === "testnet", "default network should be testnet");
  assert(preflight.api_url_kind === "testnet_api", "default API should be categorized as testnet");
  assert(status.mode === "local", "default persistence mode should be local");
  assert(status.available === true, "local simulator should remain available");
  assert(status.writable === false, "local simulator must not claim live DUAL writes");
  assert(status.network?.ready === true, "status should expose network preflight state");
  assert(preflight.public_writes === false, "preflight must not enable public writes");

  return {
    target_network: preflight.target_network,
    mode: status.mode,
    available: status.available,
    writable: status.writable,
    endpoint_kinds: endpointKinds(preflight)
  };
});

await scenario("mainnet_mode_with_default_testnet_endpoints_fails_closed", {
  DUAL_NETWORK: "mainnet",
  DUAL_PERSISTENCE_MODE: "dual",
  DUAL_WRITE_MODE: "event_bus",
  DEMO_PUBLIC_DUAL_WRITES: "true",
  DUAL_API_KEY: "dummy-api-key",
  DUAL_ORG_ID: "dummy-org",
  DUAL_AGENT_PASSPORT_TEMPLATE_ID: "dummy-template"
}, async () => {
  const config = dualNetworkConfig();
  const preflight = networkMigrationPreflight(config);
  const persistence = await createDualPersistence();
  const status = persistence.status();
  const readiness = persistence.writeReadiness();

  assert(preflight.mainnet_requested, "mainnet should be requested");
  assert(preflight.ready === false, "mainnet with default testnet endpoints must fail preflight");
  assert(preflight.read_allowed === false, "mainnet read path should be blocked");
  assert(preflight.write_allowed === false, "mainnet write path should be blocked");
  assert(status.available === false, "persistence read availability should fail closed");
  assert(status.writable === false, "persistence write availability should fail closed");
  assert(status.configured === false, "blocked network must not report configured=true");
  assert(readiness.ready === false, "write readiness must fail closed");
  assert(readiness.missing.includes("KRAKEN_MAINNET_CUTOVER_CONFIRMED=true"), "cutover confirmation should be required");
  assert(preflight.testnet_or_legacy_endpoint_count >= 4, "testnet endpoints should be counted as blockers");

  return {
    target_network: preflight.target_network,
    available: status.available,
    writable: status.writable,
    missing: preflight.missing,
    endpoint_kinds: endpointKinds(preflight)
  };
});

await scenario("mainnet_mode_with_explicit_non_testnet_endpoints_passes_preflight_only", {
  DUAL_NETWORK: "mainnet",
  KRAKEN_MAINNET_CUTOVER_CONFIRMED: "true",
  DUAL_PERSISTENCE_MODE: "dual",
  DUAL_WRITE_MODE: "event_bus",
  DUAL_API_URL: "https://api-mainnet.example.dual.invalid",
  DUAL_CONSOLE_BASE_URL: "https://console-mainnet.example.dual.invalid",
  DUAL_L3_EXPLORER_BASE_URL: "https://explorer-mainnet.example.dual.invalid",
  DUAL_L2_EXPLORER_BASE_URL: "https://l2-explorer-mainnet.example.dual.invalid"
}, async () => {
  const config = dualNetworkConfig();
  const preflight = networkMigrationPreflight(config);
  const persistence = await createDualPersistence();
  const status = persistence.status();
  const readiness = persistence.writeReadiness();

  assert(preflight.ready === true, "explicit non-testnet endpoints plus cutover flag should pass network preflight");
  assert(preflight.read_allowed === true, "network preflight should allow reads after explicit config");
  assert(preflight.write_allowed === true, "network preflight should allow writes after explicit config");
  assert(preflight.testnet_or_legacy_endpoint_count === 0, "explicit endpoints should not be categorized as testnet/legacy");
  assert(status.configured === false, "missing credentials should still prevent DUAL configured=true");
  assert(status.writable === false, "missing credentials should still prevent live writes");
  assert(readiness.ready === false, "preflight alone must not claim write readiness");

  return {
    target_network: preflight.target_network,
    network_ready: preflight.ready,
    configured: status.configured,
    writable: status.writable,
    endpoint_kinds: endpointKinds(preflight)
  };
});

await scenario("current_environment_network_preflight_snapshot", null, async () => {
  const preflight = networkMigrationPreflight(dualNetworkConfig());

  return {
    target_network: preflight.target_network,
    network_ready: preflight.ready,
    status: preflight.status,
    missing_count: preflight.missing.length,
    endpoint_kinds: endpointKinds(preflight)
  };
});

const failures = results.filter((result) => result.status !== "pass");
const output = {
  app: "kraken-dual-agent-demo",
  generated_at: new Date().toISOString(),
  status: failures.length ? "fail" : "pass",
  live_dual_calls: false,
  public_writes: false,
  secret_returned: false,
  env_keys_considered: ENV_KEYS,
  results
};

console.log(JSON.stringify(output, null, 2));
if (failures.length) process.exitCode = 1;

async function scenario(name, env, check) {
  if (env === null) {
    await runScenario(name, check);
    return;
  }

  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);

  try {
    await runScenario(name, check);
  } finally {
    for (const key of ENV_KEYS) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
  }
}

async function runScenario(name, check) {
  try {
    const evidence = await check();
    results.push({ name, status: "pass", evidence });
  } catch (error) {
    results.push({ name, status: "fail", error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function endpointKinds(preflight) {
  return {
    api: preflight.api_url_kind,
    console: preflight.console_url_kind,
    l3_explorer: preflight.l3_explorer_url_kind,
    l2_explorer: preflight.l2_explorer_url_kind
  };
}
