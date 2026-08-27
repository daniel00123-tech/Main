import { describe, expect, it, beforeEach } from "vitest";
import {
  approveProviderRateCard,
  ensureProviderCostCatalogue,
  updateDraftRateCardItems,
} from "./provider-costs";

function createMockDb() {
  const cards = new Map<string, Record<string, unknown>>();
  const items = new Map<string, Record<string, unknown>>();

  cards.set("prc_test_draft", {
    id: "prc_test_draft",
    provider: "openai",
    version_label: "TEST-draft",
    status: "draft",
    currency: "GBP",
    source_url: null,
    source_notes: null,
    verified_at: null,
    effective_from: null,
    effective_to: null,
    approved_by: null,
    approved_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  items.set("pri_test", {
    id: "pri_test",
    rate_card_id: "prc_test_draft",
    service: "chat",
    sku: null,
    billing_unit: "input_tokens",
    unit_cost_micros: 0,
    included_allowance: null,
    notes: "unset",
    created_at: "2026-01-01T00:00:00.000Z",
  });

  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM provider_rate_cards WHERE id = ?")) {
                return cards.get(String(binds[0])) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM provider_rate_items WHERE rate_card_id = ?")) {
                const cardId = String(binds[0]);
                return {
                  results: [...items.values()].filter(
                    (row) => row.rate_card_id === cardId,
                  ),
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE provider_rate_items")) {
                const row = items.get(String(binds[2]));
                if (row) {
                  row.unit_cost_micros = binds[0];
                  if (binds[1] != null) row.notes = binds[1];
                }
              }
              if (sql.includes("UPDATE provider_rate_cards")) {
                const id = binds[binds.length - 1];
                const card = cards.get(String(id));
                if (card) {
                  if (sql.includes("status = 'active'")) {
                    card.status = "active";
                    card.approved_by = binds[0];
                  }
                  if (sql.includes("status = 'superseded'")) {
                    card.status = "superseded";
                  }
                  card.updated_at = binds[0];
                }
              }
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("provider rate cards", () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockDb();
  });

  it("updates draft rate card items only", async () => {
    const updated = await updateDraftRateCardItems(
      db,
      "prc_test_draft",
      [{ id: "pri_test", unitCostMicros: 50_000, notes: "£0.05 per 1k tokens" }],
      "admin@test.com",
    );
    expect(updated.items[0]?.unitCostMicros).toBe(50_000);
  });

  it("rejects approval when all unit costs are zero", async () => {
    await expect(
      approveProviderRateCard(db, "prc_test_draft", "admin@test.com"),
    ).rejects.toThrow(/Configure at least one unit cost/);
  });

  it("approves draft card after unit costs configured", async () => {
    await updateDraftRateCardItems(
      db,
      "prc_test_draft",
      [{ id: "pri_test", unitCostMicros: 10_000 }],
      "admin@test.com",
    );
    const card = await approveProviderRateCard(db, "prc_test_draft", "admin@test.com");
    expect(card.status).toBe("active");
    expect(card.approvedBy).toBe("admin@test.com");
  });

  it("seeds catalogue providers without throwing", async () => {
    const emptyDb = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                return { success: true };
              },
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(ensureProviderCostCatalogue(emptyDb)).resolves.toBeUndefined();
  });
});
