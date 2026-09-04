#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_API_BASE || "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const KNOWLEDGE_15 = [
  { id: "K1", text: "What is the PO process?", family: "knowledge", expectedToolPrefix: "search_company_knowledge" },
  { id: "K2", text: "Find the purchase order document.", family: "knowledge", expectedToolPrefix: "search_company_knowledge" },
  { id: "K3", text: "What is the newest document?", family: "catalogue", expectedToolPrefix: "list_documents" },
  { id: "K4", text: "Show me the latest ten files.", family: "catalogue", expectedToolPrefix: "list_documents" },
  { id: "K5", text: "What is our health and safety policy?", family: "knowledge", expectedToolPrefix: "search_company_knowledge" },
  { id: "K6", text: "What is it about?", family: "knowledge", expectedToolPrefix: null },
  { id: "K7", text: "What is the source URL?", family: "knowledge", expectedToolPrefix: null },
  { id: "K8", text: "Give me more detail.", family: "knowledge", expectedToolPrefix: null },
  { id: "K9", text: "What exactly?", family: "knowledge", expectedToolPrefix: null },
  { id: "K10", text: "Who modified it?", family: "knowledge", expectedToolPrefix: null },
  { id: "K11", text: "When was it changed?", family: "knowledge", expectedToolPrefix: null },
  { id: "K12", text: "Find the rates card.", family: "knowledge", expectedToolPrefix: "search_company_knowledge" },
  { id: "K13", text: "Find a document about purple unicorn onboarding.", family: "knowledge", expectedToolPrefix: "search_company_knowledge" },
  { id: "K14", text: "hlth and safty policy", family: "knowledge", expectedToolPrefix: "search_company_knowledge" },
  { id: "K15", text: "No, I meant health and safety.", family: "correction", expectedToolPrefix: "search_company_knowledge" },
];

function d1(command) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const out = execFileSync(
        "npx",
        ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
        { cwd: apiDir, encoding: "utf8" },
      );
      return JSON.parse(out)[0]?.results ?? [];
    } catch (err) {
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function mintAcceptanceToken() {
  const token = `el_final_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

async function post(path, body) {
  const token = mintAcceptanceToken();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
      "User-Agent": "InfraAcceptance/1.0",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { httpStatus: res.status, body: json };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const report = { api: API, worker: "pending", knowledge: [], errors: [] };
let memory = null;
for (const texts of chunk(KNOWLEDGE_15, 2)) {
  const result = await post("/api/internal/el-whatsapp-qa", { texts, memory });
  if (result.httpStatus !== 200 || result.body?.error) {
    report.errors.push({ texts: texts.map((row) => row.id), result });
    console.error("FAIL", texts.map((row) => row.id), result.httpStatus, result.body?.error ?? result.body);
    continue;
  }
  memory = result.body?.memory ?? memory;
  for (const turn of result.body?.turns ?? []) report.knowledge.push(turn);
  console.log(
    "knowledge",
    texts.map((row) => row.id).join(","),
    result.body?.tallies,
    (result.body?.turns ?? []).map((t) => `${t.id}:${t.grade}`).join(" "),
  );
}

writeFileSync("/tmp/el-final-knowledge.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ written: "/tmp/el-final-knowledge.json", turns: report.knowledge.length, errors: report.errors.length }));
