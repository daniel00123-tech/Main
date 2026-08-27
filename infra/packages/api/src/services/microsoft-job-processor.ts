/**
 * Self-scheduling Microsoft file job processor — one file per Worker invocation.
 * Used when Cloudflare Queue binding is unavailable; each fetch gets a fresh subrequest budget.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../env";
import {
  finalizeMicrosoftSyncRunIfComplete,
  hasMicrosoftKnowledgeQueue,
  processMicrosoftFileJob,
} from "./microsoft-queue";

function jobProcessorToken(env: Env, syncRunId: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`microsoft-job:${syncRunId}`).digest("hex");
}

export function verifyJobProcessorToken(
  env: Env,
  syncRunId: string,
  token: string | null | undefined,
): boolean {
  if (!token) return false;
  const expected = jobProcessorToken(env, syncRunId);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

export async function kickMicrosoftJobProcessor(env: Env, syncRunId: string): Promise<void> {
  if (hasMicrosoftKnowledgeQueue(env)) return;

  const base = (env.INFRA_PUBLIC_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(
    /\/$/,
    "",
  );
  const token = jobProcessorToken(env, syncRunId);
  await fetch(`${base}/api/internal/microsoft/process-next-job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ syncRunId }),
  });
}

export async function processNextMicrosoftJob(
  env: Env,
  syncRunId: string,
): Promise<{ processed: boolean; jobId: string | null; remaining: number }> {
  const next = await env.DB.prepare(
    `SELECT id, company_id, source_id FROM microsoft_file_jobs
     WHERE sync_run_id = ? AND status IN ('queued', 'retrying')
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(syncRunId)
    .first<{ id: string; company_id: string; source_id: string }>();

  if (!next?.id) {
    const source = await env.DB.prepare(
      `SELECT source_id FROM microsoft_file_jobs WHERE sync_run_id = ? LIMIT 1`,
    )
      .bind(syncRunId)
      .first<{ source_id: string }>();
    if (source?.source_id) {
      await finalizeMicrosoftSyncRunIfComplete(env, syncRunId, source.source_id);
    }
    return { processed: false, jobId: null, remaining: 0 };
  }

  await processMicrosoftFileJob(env, {
    jobId: next.id,
    companyId: next.company_id,
    sourceId: next.source_id,
    syncRunId,
  });

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM microsoft_file_jobs
     WHERE sync_run_id = ? AND status IN ('queued', 'retrying')`,
  )
    .bind(syncRunId)
    .first<{ count: number }>();

  return {
    processed: true,
    jobId: next.id,
    remaining: remaining?.count ?? 0,
  };
}

export async function continueMicrosoftJobChain(env: Env, syncRunId: string): Promise<void> {
  if (hasMicrosoftKnowledgeQueue(env)) return;
  await kickMicrosoftJobProcessor(env, syncRunId);
}
