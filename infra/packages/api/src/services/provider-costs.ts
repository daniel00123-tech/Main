import { newId, nowIso } from "../db/mappers";

export interface ProviderRateCard {
  id: string;
  provider: string;
  versionLabel: string;
  status: string;
  currency: string;
  sourceUrl: string | null;
  sourceNotes: string | null;
  verifiedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRateItem {
  id: string;
  rateCardId: string;
  service: string;
  sku: string | null;
  billingUnit: string;
  unitCostMicros: number;
  includedAllowance: number | null;
  notes: string | null;
  createdAt: string;
}

function mapCard(row: Record<string, unknown>): ProviderRateCard {
  return {
    id: String(row.id),
    provider: String(row.provider),
    versionLabel: String(row.version_label),
    status: String(row.status),
    currency: String(row.currency ?? "GBP"),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    sourceNotes: row.source_notes ? String(row.source_notes) : null,
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
    effectiveFrom: row.effective_from ? String(row.effective_from) : null,
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapItem(row: Record<string, unknown>): ProviderRateItem {
  return {
    id: String(row.id),
    rateCardId: String(row.rate_card_id),
    service: String(row.service),
    sku: row.sku ? String(row.sku) : null,
    billingUnit: String(row.billing_unit),
    unitCostMicros: Number(row.unit_cost_micros),
    includedAllowance:
      row.included_allowance == null ? null : Number(row.included_allowance),
    notes: row.notes ? String(row.notes) : null,
    createdAt: String(row.created_at),
  };
}

export async function listProviderRateCards(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT * FROM provider_rate_cards
       ORDER BY provider ASC, created_at DESC`,
    )
    .all();
  return (result.results ?? []).map((row) => mapCard(row));
}

export async function getProviderRateCard(db: D1Database, id: string) {
  const row = await db
    .prepare(`SELECT * FROM provider_rate_cards WHERE id = ?`)
    .bind(id)
    .first();
  if (!row) return null;
  const items = await db
    .prepare(`SELECT * FROM provider_rate_items WHERE rate_card_id = ?`)
    .bind(id)
    .all();
  return {
    card: mapCard(row),
    items: (items.results ?? []).map((item) => mapItem(item)),
  };
}

export async function listPricingReviews(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT * FROM provider_pricing_reviews ORDER BY detected_at DESC LIMIT 50`,
    )
    .all();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    provider: String(row.provider),
    status: String(row.status),
    currentRateCardId: row.current_rate_card_id
      ? String(row.current_rate_card_id)
      : null,
    proposedRateCardId: row.proposed_rate_card_id
      ? String(row.proposed_rate_card_id)
      : null,
    sourceUrl: row.source_url ? String(row.source_url) : null,
    detectedAt: String(row.detected_at),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewNotes: row.review_notes ? String(row.review_notes) : null,
  }));
}

/**
 * Seed placeholder provider catalogues.
 * Unit costs are NOT claimed as live verified Cloudflare/OpenAI tariffs —
 * status remains draft until an admin approves a verified rate card.
 */
export async function ensureProviderCostCatalogue(db: D1Database) {
  const now = nowIso();

  const cards: Array<{
    id: string;
    provider: string;
    version: string;
    notes: string;
    items: Array<{
      id: string;
      service: string;
      unit: string;
      micros: number;
      notes: string;
    }>;
  }> = [
    {
      id: "prc_cf_2026_08_draft",
      provider: "cloudflare",
      version: "CF-2026-08-draft",
      notes:
        "Draft skeleton only — unit costs not verified for billing. Do not use for customer charges until approved.",
      items: [
        {
          id: "pri_cf_workers_req",
          service: "workers",
          unit: "requests",
          micros: 0,
          notes: "Not configured — set after monthly pricing review",
        },
        {
          id: "pri_cf_d1_rows_read",
          service: "d1",
          unit: "rows_read",
          micros: 0,
          notes: "Not configured",
        },
        {
          id: "pri_cf_vectorize_query",
          service: "vectorize",
          unit: "vector_dimensions_queried",
          micros: 0,
          notes: "Not configured",
        },
        {
          id: "pri_cf_workers_ai",
          service: "workers_ai",
          unit: "ai_inference_units",
          micros: 0,
          notes: "Not configured",
        },
      ],
    },
    {
      id: "prc_openai_2026_08_draft",
      provider: "openai",
      version: "OAI-2026-08-draft",
      notes: "Draft skeleton — not used for INFRA transaction costing yet.",
      items: [
        {
          id: "pri_oai_input_tokens",
          service: "chat",
          unit: "input_tokens",
          micros: 0,
          notes: "Not configured",
        },
        {
          id: "pri_oai_output_tokens",
          service: "chat",
          unit: "output_tokens",
          micros: 0,
          notes: "Not configured",
        },
      ],
    },
    {
      id: "prc_anthropic_2026_08_draft",
      provider: "anthropic",
      version: "ANT-2026-08-draft",
      notes: "Draft skeleton — not used for INFRA transaction costing yet.",
      items: [
        {
          id: "pri_ant_input_tokens",
          service: "messages",
          unit: "input_tokens",
          micros: 0,
          notes: "Not configured",
        },
        {
          id: "pri_ant_output_tokens",
          service: "messages",
          unit: "output_tokens",
          micros: 0,
          notes: "Not configured",
        },
      ],
    },
  ];

  for (const card of cards) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO provider_rate_cards (
          id, provider, version_label, status, currency, source_url, source_notes,
          verified_at, effective_from, effective_to, approved_by, approved_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'draft', 'GBP', NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(card.id, card.provider, card.version, card.notes, now, now)
      .run();

    for (const item of card.items) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO provider_rate_items (
            id, rate_card_id, service, sku, billing_unit, unit_cost_micros,
            included_allowance, notes, created_at
          ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
        )
        .bind(
          item.id,
          card.id,
          item.service,
          item.unit,
          item.micros,
          item.notes,
          now,
        )
        .run();
    }
  }
}

export async function createManualPricingReviewProposal(
  db: D1Database,
  input: {
    provider: string;
    sourceUrl?: string;
    notes?: string;
    actor: string;
  },
) {
  const now = nowIso();
  const current = await db
    .prepare(
      `SELECT id FROM provider_rate_cards
       WHERE provider = ? AND status IN ('active', 'draft')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    )
    .bind(input.provider)
    .first();

  const id = newId("prev");
  await db
    .prepare(
      `INSERT INTO provider_pricing_reviews (
        id, provider, status, current_rate_card_id, proposed_rate_card_id,
        source_url, source_snapshot, diff_json, detected_at, created_at
      ) VALUES (?, ?, 'pending', ?, NULL, ?, ?, '{}', ?, ?)`,
    )
    .bind(
      id,
      input.provider,
      current ? String(current.id) : null,
      input.sourceUrl ?? null,
      input.notes ??
        `Manual review requested by ${input.actor}. Proposed rates require admin approval before activation.`,
      now,
      now,
    )
    .run();

  return id;
}

export async function updateDraftRateCardItems(
  db: D1Database,
  cardId: string,
  items: Array<{ id: string; unitCostMicros: number; notes?: string | null }>,
  actor: string,
): Promise<{ card: ProviderRateCard; items: ProviderRateItem[] }> {
  const full = await getProviderRateCard(db, cardId);
  if (!full) throw new Error("Rate card not found");
  if (full.card.status !== "draft") {
    throw new Error("Only draft rate cards can be edited");
  }

  const itemIds = new Set(full.items.map((i) => i.id));
  for (const update of items) {
    if (!itemIds.has(update.id)) {
      throw new Error(`Unknown rate item: ${update.id}`);
    }
    if (update.unitCostMicros < 0) {
      throw new Error("Unit cost cannot be negative");
    }
    await db
      .prepare(
        `UPDATE provider_rate_items
         SET unit_cost_micros = ?, notes = COALESCE(?, notes)
         WHERE id = ? AND rate_card_id = ?`,
      )
      .bind(update.unitCostMicros, update.notes ?? null, update.id, cardId)
      .run();
  }

  await db
    .prepare(`UPDATE provider_rate_cards SET updated_at = ? WHERE id = ?`)
    .bind(nowIso(), cardId)
    .run();

  const refreshed = await getProviderRateCard(db, cardId);
  if (!refreshed) throw new Error("Rate card not found after update");
  return { card: refreshed.card, items: refreshed.items };
}

export async function approveProviderRateCard(
  db: D1Database,
  cardId: string,
  actor: string,
): Promise<ProviderRateCard> {
  const full = await getProviderRateCard(db, cardId);
  if (!full) throw new Error("Rate card not found");
  if (!["draft", "proposed"].includes(full.card.status)) {
    throw new Error("Only draft or proposed rate cards can be approved");
  }

  const hasConfiguredCost = full.items.some((item) => item.unitCostMicros > 0);
  if (!hasConfiguredCost) {
    throw new Error(
      "Configure at least one unit cost before approving. Zero-cost cards cannot be activated.",
    );
  }

  const now = nowIso();
  await db
    .prepare(
      `UPDATE provider_rate_cards
       SET status = 'superseded', effective_to = ?, updated_at = ?
       WHERE provider = ? AND status = 'active' AND id != ?`,
    )
    .bind(now, now, full.card.provider, cardId)
    .run();

  await db
    .prepare(
      `UPDATE provider_rate_cards
       SET status = 'active', approved_by = ?, approved_at = ?, verified_at = ?,
           effective_from = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(actor, now, now, now, now, cardId)
    .run();

  const row = await db
    .prepare(`SELECT * FROM provider_rate_cards WHERE id = ?`)
    .bind(cardId)
    .first();
  if (!row) throw new Error("Rate card missing after approval");
  return mapCard(row);
}
