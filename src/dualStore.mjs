import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const seedPath = join(root, "data", "seed.json");
const statePath = join(root, "data", "state.json");

export async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    const seed = JSON.parse(await readFile(seedPath, "utf8"));
    await saveState(seed);
    return seed;
  }
}

export async function resetState() {
  const seed = JSON.parse(await readFile(seedPath, "utf8"));
  seed.audit = seed.audit.map((event) => ({ ...event, timestamp: new Date().toISOString() }));
  await saveState(seed);
  return seed;
}

export async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

export async function appendAudit(type, status, title, detail, payload = {}) {
  const state = await loadState();
  const event = createAuditEvent(type, status, title, detail, payload);
  state.audit.unshift(event);
  await saveState(state);
  return { state, event };
}

export function createAuditEvent(type, status, title, detail, payload = {}) {
  const timestamp = new Date().toISOString();
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ type, status, title, detail, payload, timestamp }))
    .digest("hex");

  return {
    id: `evt-${hash.slice(0, 10)}`,
    type,
    status,
    title,
    detail,
    payload,
    timestamp,
    provenanceHash: hash
  };
}

export function createProposal(trade, policy) {
  const id = `prop-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    trade,
    policy,
    state: policy.decision === "block" ? "blocked" : policy.decision === "needs_approval" ? "awaiting_approval" : "approved",
    approved: policy.decision === "allow",
    createdAt: new Date().toISOString(),
    executedAt: null,
    result: null
  };
}
