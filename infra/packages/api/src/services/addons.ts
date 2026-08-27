import { newId, nowIso } from "../db/mappers";

export async function listAddonCatalog(db: D1Database) {
  const rows = await db
    .prepare(`SELECT * FROM addon_catalog WHERE status IN ('active', 'draft') ORDER BY name ASC`)
    .all();

  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    monthlyPriceCents: Number(row.monthly_price_cents),
    status: String(row.status),
    capabilities: JSON.parse(String(row.capabilities_json ?? "[]")) as string[],
  }));
}

export async function listCompanyAddons(db: D1Database, companyId: string) {
  const rows = await db
    .prepare(
      `SELECT s.*, a.slug, a.name, a.description, a.monthly_price_cents, a.capabilities_json
       FROM company_addon_subscriptions s
       JOIN addon_catalog a ON a.id = s.addon_id
       WHERE s.company_id = ?
       ORDER BY s.created_at DESC`,
    )
    .bind(companyId)
    .all();

  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    addonId: String(row.addon_id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    monthlyPriceCents: Number(row.monthly_price_cents),
    status: String(row.status),
    capabilities: JSON.parse(String(row.capabilities_json ?? "[]")) as string[],
    activatedAt: row.activated_at ? String(row.activated_at) : null,
  }));
}

export async function requestCompanyAddon(
  db: D1Database,
  companyId: string,
  addonSlug: string,
) {
  const addon = await db
    .prepare(`SELECT id, status FROM addon_catalog WHERE slug = ?`)
    .bind(addonSlug)
    .first();
  if (!addon) throw new Error("ADDON_NOT_FOUND");
  if (String(addon.status) !== "active") throw new Error("ADDON_NOT_AVAILABLE");

  const id = newId("caddon");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO company_addon_subscriptions (id, company_id, addon_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'requested', ?, ?)
       ON CONFLICT(company_id, addon_id) DO UPDATE SET status = 'requested', updated_at = excluded.updated_at`,
    )
    .bind(id, companyId, addon.id, now, now)
    .run();

  return { id, status: "requested" };
}

export async function seedDefaultAddonCatalog(db: D1Database) {
  const defaults = [
    {
      slug: "enhanced-support",
      name: "Enhanced support",
      description: "Priority response from the INFRA support team during business hours.",
      price: 9900,
    },
    {
      slug: "automation-capacity",
      name: "Additional automation capacity",
      description: "Higher action-plan throughput for complex automation workflows.",
      price: 14900,
    },
  ];

  const now = nowIso();
  for (const item of defaults) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO addon_catalog (
          id, slug, name, description, monthly_price_cents, status, capabilities_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', '[]', ?, ?)`,
      )
      .bind(newId("addon"), item.slug, item.name, item.description, item.price, now, now)
      .run();
  }
}
