import { newId, nowIso } from "../db/mappers";

export const OVERHEAD_CATEGORIES = [
  "development_tooling",
  "ai_subscription",
  "infrastructure_fixed",
  "software",
  "other",
] as const;

export type OverheadCategory = (typeof OVERHEAD_CATEGORIES)[number];

export interface PlatformOverhead {
  id: string;
  provider: string;
  description: string;
  monthlyCostCents: number;
  currency: string;
  startDate: string;
  endDate: string | null;
  category: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: Record<string, unknown>): PlatformOverhead {
  return {
    id: String(row.id),
    provider: String(row.provider),
    description: String(row.description),
    monthlyCostCents: Number(row.monthly_cost_cents),
    currency: String(row.currency ?? "GBP"),
    startDate: String(row.start_date),
    endDate: row.end_date ? String(row.end_date) : null,
    category: String(row.category),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function overheadActiveInPeriod(
  overhead: Pick<PlatformOverhead, "startDate" | "endDate">,
  from: string,
  to: string,
): boolean {
  if (overhead.startDate >= to) return false;
  if (overhead.endDate && overhead.endDate <= from) return false;
  return true;
}

export async function listPlatformOverheads(db: D1Database): Promise<PlatformOverhead[]> {
  const result = await db
    .prepare(`SELECT * FROM platform_overheads ORDER BY start_date DESC, provider ASC`)
    .all();
  return (result.results ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function createPlatformOverhead(
  db: D1Database,
  input: {
    provider: string;
    description: string;
    monthlyCostCents: number;
    currency?: string;
    startDate: string;
    endDate?: string | null;
    category: string;
    createdBy?: string | null;
  },
): Promise<PlatformOverhead> {
  const id = newId("oh");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO platform_overheads (
         id, provider, description, monthly_cost_cents, currency, start_date, end_date,
         category, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.provider.trim(),
      input.description.trim(),
      Math.round(input.monthlyCostCents),
      input.currency ?? "GBP",
      input.startDate,
      input.endDate ?? null,
      input.category,
      input.createdBy ?? null,
      now,
      now,
    )
    .run();
  const row = await db.prepare(`SELECT * FROM platform_overheads WHERE id = ?`).bind(id).first();
  if (!row) throw new Error("Failed to create platform overhead");
  return mapRow(row as Record<string, unknown>);
}

export async function updatePlatformOverhead(
  db: D1Database,
  id: string,
  input: Partial<{
    provider: string;
    description: string;
    monthlyCostCents: number;
    currency: string;
    startDate: string;
    endDate: string | null;
    category: string;
  }>,
): Promise<PlatformOverhead | null> {
  const existing = await db.prepare(`SELECT * FROM platform_overheads WHERE id = ?`).bind(id).first();
  if (!existing) return null;
  const next = mapRow(existing as Record<string, unknown>);
  const updated: PlatformOverhead = {
    ...next,
    provider: input.provider?.trim() ?? next.provider,
    description: input.description?.trim() ?? next.description,
    monthlyCostCents: input.monthlyCostCents ?? next.monthlyCostCents,
    currency: input.currency ?? next.currency,
    startDate: input.startDate ?? next.startDate,
    endDate: input.endDate === undefined ? next.endDate : input.endDate,
    category: input.category ?? next.category,
    updatedAt: nowIso(),
  };
  await db
    .prepare(
      `UPDATE platform_overheads
       SET provider = ?, description = ?, monthly_cost_cents = ?, currency = ?,
           start_date = ?, end_date = ?, category = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      updated.provider,
      updated.description,
      updated.monthlyCostCents,
      updated.currency,
      updated.startDate,
      updated.endDate,
      updated.category,
      updated.updatedAt,
      id,
    )
    .run();
  return updated;
}

export async function deletePlatformOverhead(db: D1Database, id: string): Promise<boolean> {
  await db.prepare(`DELETE FROM platform_overheads WHERE id = ?`).bind(id).run();
  return true;
}

export function summariseOverheads(
  overheads: PlatformOverhead[],
  from: string,
  to: string,
): { monthlyCostCents: number; activeCount: number; currency: string } {
  const active = overheads.filter((item) => overheadActiveInPeriod(item, from, to));
  return {
    monthlyCostCents: active.reduce((sum, item) => sum + item.monthlyCostCents, 0),
    activeCount: active.length,
    currency: "GBP",
  };
}
