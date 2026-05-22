import { spawn } from "node:child_process";
import crypto from "node:crypto";

const SIM_SOURCE = "simulated";
const CLI_SOURCE = "kraken-cli";
const API_SOURCE = "kraken-public-api";

const KRAKEN_PUBLIC_PAIRS = {
  BTCUSD: "XBTUSD",
  XBTUSD: "XBTUSD",
  ETHUSD: "ETHUSD",
  SOLUSD: "SOLUSD",
  DUALUSD: "DUALUSD"
};

export async function getMarket(pair, fallbackMarket = {}) {
  const normalizedPair = String(pair || "BTCUSD").toUpperCase();
  const cli = await runKraken(["ticker", normalizedPair, "-o", "json"]);

  if (cli.ok) {
    const normalized = normalizeTicker(normalizedPair, cli.json);
    if (normalized) return { ...normalized, source: CLI_SOURCE, raw: cli.json };
  }

  const api = await getKrakenPublicTicker(normalizedPair);
  if (api.ok) {
    return { ...api.market, source: API_SOURCE, cliFallbackReason: cli.error?.message || null, raw: api.raw };
  }

  return simulatedMarket(normalizedPair, fallbackMarket[normalizedPair], api.error || cli.error);
}

export async function executePaperTrade(trade) {
  const args = ["paper", trade.side, trade.pair, String(trade.quantity), "-o", "json"];
  const init = await runKraken(["paper", "init", "--balance", "10000", "-o", "json"], { tolerateFailure: true });
  const result = await runKraken(args);

  if (result.ok) {
    return {
      mode: "paper",
      source: CLI_SOURCE,
      executionPath: "kraken-cli-paper",
      degradation: null,
      command: `kraken ${args.join(" ")}`,
      initialized: init.ok,
      orderId: extractOrderId(result.json),
      response: result.json,
      digest: digest(result.json)
    };
  }

  return simulatedPaperTrade(trade, result.error);
}

export async function getAdapterStatus() {
  const result = await runKraken(["status", "-o", "json"], { timeoutMs: 2500, tolerateFailure: true });
  if (!result.ok) {
    const api = await getKrakenPublicTicker("BTCUSD", { timeoutMs: 5000 });
    if (api.ok) {
      return {
        krakenCliAvailable: false,
        krakenPublicApiAvailable: true,
        source: API_SOURCE,
        detail: "Kraken CLI is unavailable; using Kraken public market-data API."
      };
    }
  }

  return {
    krakenCliAvailable: result.ok,
    krakenPublicApiAvailable: false,
    source: result.ok ? CLI_SOURCE : SIM_SOURCE,
    detail: result.ok ? "Kraken CLI is available." : "Kraken CLI was not found or did not respond; using simulator fallback."
  };
}

async function getKrakenPublicTicker(pair, options = {}) {
  const apiPair = KRAKEN_PUBLIC_PAIRS[pair] || pair;
  const timeoutMs = options.timeoutMs || 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(apiPair)}`, {
      signal: controller.signal
    });
    const json = await response.json();
    if (!response.ok || json.error?.length) {
      return {
        ok: false,
        error: {
          message: json.error?.join("; ") || `Kraken public API returned ${response.status}.`,
          code: response.status
        }
      };
    }

    const normalized = normalizeTicker(pair, json.result);
    if (!normalized) {
      return { ok: false, error: { message: "Kraken public API returned an unrecognized ticker payload.", code: "bad_payload" } };
    }

    return { ok: true, market: normalized, raw: json.result };
  } catch (error) {
    return { ok: false, error: { message: error.message, code: error.name || "kraken_api_error" } };
  } finally {
    clearTimeout(timer);
  }
}

async function runKraken(args, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;

  return new Promise((resolve) => {
    const child = spawn("kraken", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: { message: "Kraken CLI timed out.", code: "timeout" } });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: { message: error.message, code: error.code || "spawn_error" } });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const parsed = parseJson(stdout);
      if (code === 0 && parsed.ok) {
        resolve({ ok: true, json: parsed.value });
      } else {
        resolve({
          ok: false,
          error: {
            message: parsed.ok ? "Kraken CLI returned a non-zero exit code." : "Kraken CLI returned non-JSON output.",
            code: code ?? "unknown",
            stdout,
            stderr
          }
        });
      }
    });
  });
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function normalizeTicker(pair, json) {
  const payload = json?.[pair] || Object.values(json || {})[0];
  if (!payload) return null;

  const last = Number(payload.c?.[0] || payload.last || payload.price);
  const ask = Number(payload.a?.[0] || payload.ask || last);
  const bid = Number(payload.b?.[0] || payload.bid || last);
  const volume = Number(payload.v?.[1] || payload.volume || 0);

  if (!Number.isFinite(last) || last <= 0) return null;

  return {
    pair,
    price: round(last),
    ask: round(ask),
    bid: round(bid),
    changePct: 0,
    volume: round(volume),
    timestamp: new Date().toISOString()
  };
}

function simulatedMarket(pair, seed = {}, error = null) {
  const base = seed.price || ({ BTCUSD: 67234.1, ETHUSD: 3542.4, SOLUSD: 147.22, DUALUSD: 0.0055 }[pair] || 100);
  const wobble = Math.sin(Date.now() / 45000 + pair.length) * 0.006;
  const price = round(base * (1 + wobble));

  return {
    pair,
    price,
    ask: round(price * 1.0004),
    bid: round(price * 0.9996),
    changePct: round(seed.changePct ?? wobble * 100),
    volume: round(seed.volume || 1000),
    source: SIM_SOURCE,
    fallbackReason: error?.message || "Kraken CLI unavailable.",
    timestamp: new Date().toISOString()
  };
}

function simulatedPaperTrade(trade, error = null) {
  const payload = {
    mode: "paper",
    source: SIM_SOURCE,
    executionPath: "simulator",
    degradation: error?.code && error.code !== "ENOENT" ? error.message : null,
    pair: trade.pair,
    side: trade.side,
    quantity: Number(trade.quantity),
    price: Number(trade.price),
    notional: round(Number(trade.quantity) * Number(trade.price)),
    fee: round(Number(trade.quantity) * Number(trade.price) * 0.0026),
    orderId: `paper-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString()
  };

  return {
    ...payload,
    command: `kraken paper ${trade.side} ${trade.pair} ${trade.quantity} -o json`,
    response: payload,
    digest: digest(payload)
  };
}

function extractOrderId(json) {
  return json?.order_id || json?.orderId || json?.txid?.[0] || json?.id || `kraken-${crypto.randomUUID().slice(0, 8)}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function round(value) {
  const amount = Number(value || 0);
  const precision = Math.abs(amount) < 1 ? 1000000 : 100;
  return Math.round(amount * precision) / precision;
}
