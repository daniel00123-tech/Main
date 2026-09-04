import type { Env } from "../env";

export const KNOWLEDGE_BREAKER_THRESHOLD = 3;
export const KNOWLEDGE_BREAKER_COOLDOWN_MS = 60_000;

export type KnowledgeCircuitState = "closed" | "open";

export type KnowledgeCircuitSnapshot = {
  companyId: string;
  state: KnowledgeCircuitState;
  consecutiveTimeouts: number;
  cooldownUntil: string | null;
  lastError: string | null;
  open: boolean;
};

export async function ensureKnowledgeCircuitTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_knowledge_circuit (
       company_id TEXT PRIMARY KEY,
       consecutive_timeouts INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL DEFAULT 'closed',
       opened_at TEXT,
       cooldown_until TEXT,
       last_error TEXT,
       updated_at TEXT NOT NULL
     )`,
  )
    .run()
    .catch(() => undefined);
}

export async function knowledgeCircuitOpen(env: Env, companyId: string): Promise<KnowledgeCircuitSnapshot> {
  await ensureKnowledgeCircuitTable(env);
  const empty: KnowledgeCircuitSnapshot = {
    companyId,
    state: "closed",
    consecutiveTimeouts: 0,
    cooldownUntil: null,
    lastError: null,
    open: false,
  };
  try {
    const row = await env.DB.prepare(
      `SELECT consecutive_timeouts, state, cooldown_until, last_error
       FROM whatsapp_knowledge_circuit WHERE company_id = ? LIMIT 1`,
    )
      .bind(companyId)
      .first<{
        consecutive_timeouts: number;
        state: string;
        cooldown_until: string | null;
        last_error: string | null;
      }>();
    if (!row) return empty;
    const until = row.cooldown_until ? Date.parse(row.cooldown_until) : 0;
    const open = row.state === "open" && Number.isFinite(until) && until > Date.now();
    if (row.state === "open" && !open) {
      await env.DB.prepare(
        `UPDATE whatsapp_knowledge_circuit
         SET state = 'closed', cooldown_until = NULL, updated_at = ?
         WHERE company_id = ?`,
      )
        .bind(new Date().toISOString(), companyId)
        .run()
        .catch(() => undefined);
      return { ...empty, consecutiveTimeouts: Number(row.consecutive_timeouts ?? 0), lastError: row.last_error };
    }
    return {
      companyId,
      state: open ? "open" : "closed",
      consecutiveTimeouts: Number(row.consecutive_timeouts ?? 0),
      cooldownUntil: row.cooldown_until,
      lastError: row.last_error,
      open,
    };
  } catch {
    return empty;
  }
}

export async function recordKnowledgeSuccess(env: Env, companyId: string): Promise<void> {
  await ensureKnowledgeCircuitTable(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO whatsapp_knowledge_circuit (company_id, consecutive_timeouts, state, opened_at, cooldown_until, last_error, updated_at)
     VALUES (?, 0, 'closed', NULL, NULL, NULL, ?)
     ON CONFLICT(company_id) DO UPDATE SET
       consecutive_timeouts = 0,
       state = 'closed',
       opened_at = NULL,
       cooldown_until = NULL,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(companyId, now)
    .run()
    .catch(() => undefined);
}

export async function recordKnowledgeTimeout(env: Env, companyId: string, error: string): Promise<KnowledgeCircuitSnapshot> {
  await ensureKnowledgeCircuitTable(env);
  const current = await knowledgeCircuitOpen(env, companyId);
  const next = current.consecutiveTimeouts + 1;
  const now = new Date().toISOString();
  const open = next >= KNOWLEDGE_BREAKER_THRESHOLD;
  const cooldownUntil = open ? new Date(Date.now() + KNOWLEDGE_BREAKER_COOLDOWN_MS).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO whatsapp_knowledge_circuit (company_id, consecutive_timeouts, state, opened_at, cooldown_until, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id) DO UPDATE SET
       consecutive_timeouts = excluded.consecutive_timeouts,
       state = excluded.state,
       opened_at = excluded.opened_at,
       cooldown_until = excluded.cooldown_until,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  )
    .bind(companyId, next, open ? "open" : "closed", open ? now : null, cooldownUntil, error.slice(0, 200), now)
    .run()
    .catch(() => undefined);
  return {
    companyId,
    state: open ? "open" : "closed",
    consecutiveTimeouts: next,
    cooldownUntil,
    lastError: error,
    open,
  };
}

export async function listOpenKnowledgeCircuits(env: Env): Promise<KnowledgeCircuitSnapshot[]> {
  await ensureKnowledgeCircuitTable(env);
  try {
    const rows = await env.DB.prepare(
      `SELECT company_id, consecutive_timeouts, state, cooldown_until, last_error
       FROM whatsapp_knowledge_circuit WHERE state = 'open'`,
    ).all<{
      company_id: string;
      consecutive_timeouts: number;
      state: string;
      cooldown_until: string | null;
      last_error: string | null;
    }>();
    const now = Date.now();
    return (rows.results ?? [])
      .map((row) => {
        const until = row.cooldown_until ? Date.parse(row.cooldown_until) : 0;
        const open = row.state === "open" && until > now;
        return {
          companyId: row.company_id,
          state: (open ? "open" : "closed") as KnowledgeCircuitState,
          consecutiveTimeouts: Number(row.consecutive_timeouts ?? 0),
          cooldownUntil: row.cooldown_until,
          lastError: row.last_error,
          open,
        };
      })
      .filter((row) => row.open);
  } catch {
    return [];
  }
}
