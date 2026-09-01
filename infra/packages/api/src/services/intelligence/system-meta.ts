import { listConnectedCapabilityLabels, listConnectedConnectorIds } from "../whatsapp-capabilities.js";
import { listAutomationDefinitions } from "../automation-engine/store.js";
import type { Env } from "../../env.js";
import { isListCompanyDocumentsTool, listCompanyDocuments, verbaliseCatalogue } from "../document-catalogue.js";

export type IndexSourceCount = { source: string; count: number };
export type IndexTypeCount = { type: string; count: number };

export type DocumentIndexStats = {
  totalIndexed: number;
  bySource: IndexSourceCount[];
  byType: IndexTypeCount[];
  lastSyncAt: string | null;
  permissionScope: "visible_to_you";
  microsoftOnly?: boolean;
  driveConnected?: boolean;
  driveCountReliable?: boolean;
  connectedSystems?: string[];
};

export type ConnectorStatusView = {
  connected: string[];
};

export type AutomationView = {
  active: string[];
  paused: string[];
};

export type UserCapabilitiesView = {
  canHelpWith: string[];
  connectedSystems: string[];
  permittedReads: string[];
};

export type CompanySystemSummary = {
  company: string;
  indexed: DocumentIndexStats;
  connectors: string[];
  automations: AutomationView;
  users: { count: number } | null;
  lastSyncAt: string | null;
  adminOps?: {
    unhealthyConnectors: number;
  } | null;
};

export type SystemMetaActor = {
  role?: string | null;
  isPlatformAdmin?: boolean;
  canReadKnowledge?: boolean;
  canReadUsers?: boolean;
  canReadAutomations?: boolean;
};

type CacheEntry = { at: number; summary: CompanySystemSummary };
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

const SOURCE_LABELS: Record<string, string> = {
  sharepoint: "SharePoint",
  onedrive: "OneDrive",
  outlook_shared: "Email",
  outlook: "Email",
  email: "Email",
  mailbox: "Email",
  google_drive: "Google Drive",
  gdrive: "Google Drive",
  drive: "Google Drive",
  xero: "Xero",
};

export function userFacingSourceLabel(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return SOURCE_LABELS[key] ?? titleCase(raw.replace(/[_-]+/g, " "));
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function typeLabel(mime: string | null | undefined): string {
  const raw = String(mime ?? "").toLowerCase();
  if (!raw) return "Other";
  if (raw.includes("pdf")) return "PDF";
  if (raw.includes("spreadsheet") || raw.includes("excel") || raw.includes("csv") || raw.includes("sheet")) {
    return "Spreadsheet";
  }
  if (raw.includes("word") || raw.includes("document") || raw.includes("msword")) return "Document";
  if (raw.includes("presentation") || raw.includes("powerpoint")) return "Presentation";
  if (raw.includes("email") || raw.includes("message") || raw.includes("outlook")) return "Email";
  if (raw.includes("image")) return "Image";
  return "Other";
}

function canSeeUsers(actor: SystemMetaActor): boolean {
  if (actor.isPlatformAdmin) return true;
  const role = String(actor.role ?? "").toLowerCase();
  return role === "owner" || role === "admin" || role === "company_admin" || role === "director";
}

export function isSystemMetaTool(name: string): boolean {
  return (
    name === "get_company_system_summary" ||
    name === "get_document_index_stats" ||
    name === "get_connector_status" ||
    name === "get_active_automations" ||
    name === "get_user_capabilities" ||
    name === "get_recent_sync_status" ||
    name === "list_company_documents"
  );
}

export async function loadCompanySystemSummary(
  env: Pick<Env, "DB">,
  companyId: string,
  actor: SystemMetaActor,
  extras?: { driveIndexed?: number | null; companyName?: string | null },
): Promise<CompanySystemSummary> {
  const cached = cache.get(companyId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return applyActorFilter(cached.summary, actor, extras);
  }
  const [indexed, connectors, automations, users, companyName, unhealthy] = await Promise.all([
    loadDocumentIndexStats(env, companyId, extras?.driveIndexed),
    loadConnectorLabels(env, companyId),
    loadAutomations(env, companyId, actor),
    loadUserCount(env, companyId, actor),
    loadCompanyName(env, companyId, extras?.companyName),
    loadUnhealthyConnectorCount(env, companyId, actor),
  ]);
  const summary: CompanySystemSummary = {
    company: companyName,
    indexed,
    connectors,
    automations,
    users,
    lastSyncAt: indexed.lastSyncAt,
    adminOps: actor.isPlatformAdmin ? { unhealthyConnectors: unhealthy } : null,
  };
  cache.set(companyId, { at: Date.now(), summary });
  return applyActorFilter(summary, actor, extras);
}

function applyActorFilter(
  summary: CompanySystemSummary,
  actor: SystemMetaActor,
  extras?: { driveIndexed?: number | null },
): CompanySystemSummary {
  const indexed = extras?.driveIndexed != null ? mergeDriveCount(summary.indexed, extras.driveIndexed) : summary.indexed;
  return {
    ...summary,
    indexed,
    users: canSeeUsers(actor) ? summary.users : null,
    adminOps: actor.isPlatformAdmin ? summary.adminOps : null,
    lastSyncAt: indexed.lastSyncAt,
  };
}

function mergeDriveCount(stats: DocumentIndexStats, driveIndexed: number): DocumentIndexStats {
  const withoutDrive = stats.bySource.filter((row) => row.source !== "Google Drive");
  const bySource = [...withoutDrive, { source: "Google Drive", count: driveIndexed }].sort((a, b) => b.count - a.count);
  const msTotal = withoutDrive.reduce((sum, row) => sum + row.count, 0);
  return {
    ...stats,
    totalIndexed: msTotal + driveIndexed,
    bySource,
    driveCountReliable: true,
    microsoftOnly: false,
    driveConnected: true,
  };
}

export async function loadDocumentIndexStats(
  env: Pick<Env, "DB">,
  companyId: string,
  driveIndexed?: number | null,
): Promise<DocumentIndexStats> {
  const bySource = new Map<string, number>();
  const byType = new Map<string, number>();
  let lastSyncAt: string | null = null;
  let total = 0;

  try {
    const rows = await env.DB.prepare(
      `SELECT source_type AS source_type, COUNT(*) AS n
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'
       GROUP BY source_type`,
    )
      .bind(companyId)
      .all<{ source_type: string; n: number }>();
    for (const row of rows.results ?? []) {
      const label = userFacingSourceLabel(row.source_type);
      const count = Number(row.n ?? 0);
      if (!Number.isFinite(count) || count < 0) continue;
      bySource.set(label, (bySource.get(label) ?? 0) + count);
      total += count;
    }
  } catch {
    // Table or column may be absent in some test fixtures.
  }

  try {
    const rows = await env.DB.prepare(
      `SELECT mime_type AS mime_type, COUNT(*) AS n
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'
       GROUP BY mime_type`,
    )
      .bind(companyId)
      .all<{ mime_type: string | null; n: number }>();
    for (const row of rows.results ?? []) {
      const label = typeLabel(row.mime_type);
      const count = Number(row.n ?? 0);
      if (!Number.isFinite(count) || count < 0) continue;
      byType.set(label, (byType.get(label) ?? 0) + count);
    }
  } catch {
    // mime_type grouping is optional.
  }

  try {
    const row = await env.DB.prepare(
      `SELECT MAX(COALESCE(indexed_at, updated_at, created_at)) AS last_sync
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'`,
    )
      .bind(companyId)
      .first<{ last_sync: string | null }>();
    lastSyncAt = row?.last_sync ?? null;
  } catch {
    lastSyncAt = null;
  }

  try {
    const sourceRows = await env.DB.prepare(
      `SELECT source_type, SUM(COALESCE(items_indexed, 0)) AS n, MAX(last_sync_at) AS last_sync
       FROM microsoft_connector_sources
       WHERE company_id = ?
       GROUP BY source_type`,
    )
      .bind(companyId)
      .all<{ source_type: string; n: number; last_sync: string | null }>();
    if (total === 0) {
      for (const row of sourceRows.results ?? []) {
        const label = userFacingSourceLabel(row.source_type);
        const count = Number(row.n ?? 0);
        if (!Number.isFinite(count) || count <= 0) continue;
        bySource.set(label, (bySource.get(label) ?? 0) + count);
        total += count;
      }
    }
    for (const row of sourceRows.results ?? []) {
      if (row.last_sync && (!lastSyncAt || row.last_sync > lastSyncAt)) lastSyncAt = row.last_sync;
    }
  } catch {
    // connector source aggregates are a fallback, not required.
  }

  const driveReliable = typeof driveIndexed === "number" && Number.isFinite(driveIndexed) && driveIndexed >= 0;
  if (driveReliable) {
    bySource.set("Google Drive", driveIndexed);
  }

  const bySourceRows = [...bySource.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
  const microsoftTotal = bySourceRows
    .filter((row) => !/google drive/i.test(row.source))
    .reduce((sum, row) => sum + row.count, 0);

  return {
    totalIndexed: driveReliable ? microsoftTotal + driveIndexed : microsoftTotal,
    bySource: bySourceRows,
    byType: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    lastSyncAt,
    permissionScope: "visible_to_you",
    microsoftOnly: !driveReliable,
    driveCountReliable: driveReliable,
  };
}

async function loadConnectorLabels(env: Pick<Env, "DB">, companyId: string): Promise<string[]> {
  try {
    return await listConnectedCapabilityLabels(env as Env, companyId);
  } catch {
    return [];
  }
}

async function loadAutomations(
  env: Pick<Env, "DB">,
  companyId: string,
  actor: SystemMetaActor,
): Promise<AutomationView> {
  if (actor.canReadAutomations === false) return { active: [], paused: [] };
  try {
    const items = await listAutomationDefinitions(env.DB, companyId);
    return {
      active: items.filter((item) => item.status === "active").map((item) => item.name).slice(0, 12),
      paused: items.filter((item) => item.status === "paused").map((item) => item.name).slice(0, 12),
    };
  } catch {
    return { active: [], paused: [] };
  }
}

async function loadUserCount(
  env: Pick<Env, "DB">,
  companyId: string,
  actor: SystemMetaActor,
): Promise<{ count: number } | null> {
  if (!canSeeUsers(actor)) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM company_memberships WHERE company_id = ? AND status = 'active'`,
    )
      .bind(companyId)
      .first<{ n: number }>();
    const count = Number(row?.n ?? 0);
    return Number.isFinite(count) ? { count } : null;
  } catch {
    return null;
  }
}

async function loadCompanyName(
  env: Pick<Env, "DB">,
  companyId: string,
  provided?: string | null,
): Promise<string> {
  if (provided) return provided;
  try {
    const row = await env.DB.prepare(`SELECT name FROM companies WHERE id = ?`)
      .bind(companyId)
      .first<{ name: string }>();
    return row?.name || "your company";
  } catch {
    return "your company";
  }
}

async function loadUnhealthyConnectorCount(
  env: Pick<Env, "DB">,
  companyId: string,
  actor: SystemMetaActor,
): Promise<number> {
  if (!actor.isPlatformAdmin) return 0;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n
       FROM connector_instances
       WHERE company_id = ?
         AND (
           auth_status != 'connected'
           OR COALESCE(status, '') IN ('error', 'needs_attention', 'disabled')
         )`,
    )
      .bind(companyId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function executeSystemMetaTool(
  env: Pick<Env, "DB">,
  input: {
    name: string;
    companyId: string;
    actor: SystemMetaActor;
    connectors?: string[];
    companyName?: string | null;
    driveIndexed?: number | null;
    permittedReads?: string[];
    arguments?: Record<string, unknown>;
  },
): Promise<unknown> {
  if (isListCompanyDocumentsTool(input.name)) {
    if (input.actor.canReadKnowledge === false) {
      return { sort: "newest", documents: [], note: "Your current permissions don’t allow document listing." };
    }
    const args = input.arguments ?? {};
    return listCompanyDocuments(env as Env, {
      companyId: input.companyId,
      text: typeof args.query === "string" ? args.query : "",
      sort:
        args.sort === "newest" || args.sort === "latest" || args.sort === "indexed"
          ? args.sort
          : undefined,
      source:
        args.source === "onedrive" || args.source === "sharepoint" || args.source === "drive" || args.source === "all"
          ? args.source
          : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
  }
  const summary = await loadCompanySystemSummary(env, input.companyId, input.actor, {
    driveIndexed: input.driveIndexed,
    companyName: input.companyName,
  });
  if (input.name === "get_document_index_stats") {
    return attachIndexHonesty(summary.indexed, summary.connectors, input.connectors);
  }
  if (input.name === "get_connector_status") return { connected: summary.connectors };
  if (input.name === "get_active_automations") return summary.automations;
  if (input.name === "get_recent_sync_status") {
    return {
      lastSyncAt: summary.lastSyncAt,
      bySource: summary.indexed.bySource,
    };
  }
  if (input.name === "get_user_capabilities") {
    const connected = summary.connectors;
    const canHelpWith = [
      "search documents you can access",
      "list newest or latest OneDrive, SharePoint, and Drive files",
      connected.some((label) => /Xero/i.test(label)) ? "check permitted finance figures" : null,
      connected.some((label) => /mailbox|email/i.test(label)) ? "search shared mailboxes" : null,
      "tell you how many files are indexed",
      "say which systems are connected",
    ].filter((row): row is string => Boolean(row));
    return {
      canHelpWith,
      connectedSystems: connected,
      permittedReads: (input.permittedReads ?? []).filter((name) => !name.startsWith("xero_") || connected.some((label) => /Xero/i.test(label))),
    } satisfies UserCapabilitiesView;
  }
  return {
    ...summary,
    indexed: attachIndexHonesty(summary.indexed, summary.connectors, input.connectors),
  };
}

function attachIndexHonesty(
  indexed: DocumentIndexStats,
  summaryConnectors: string[],
  extraConnectors?: string[],
): DocumentIndexStats {
  const connected = [...new Set([...(extraConnectors ?? []), ...summaryConnectors])];
  const driveConnected =
    connected.some((row) => /google drive|drive files|conn_google_drive/i.test(row)) ||
    indexed.bySource.some((row) => /google drive/i.test(row.source));
  return {
    ...indexed,
    connectedSystems: connected,
    driveConnected,
    driveCountReliable:
      indexed.driveCountReliable === true || indexed.bySource.some((row) => /google drive/i.test(row.source)),
    microsoftOnly:
      indexed.driveCountReliable !== true && !indexed.bySource.some((row) => /google drive/i.test(row.source)),
  };
}

export function verbaliseSystemMeta(name: string, data: unknown, question?: string): string {
  if (name === "get_user_capabilities") return verbaliseCapabilities(data);
  if (name === "get_connector_status") return verbaliseConnectors(data);
  if (name === "get_active_automations") return verbaliseAutomations(data);
  if (name === "get_recent_sync_status") return verbaliseSync(data);
  if (name === "get_document_index_stats") return verbaliseIndexStats(data, question);
  if (name === "list_company_documents") return verbaliseCatalogue(data);
  return verbaliseSummary(data, question);
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function verbaliseIndexStats(data: unknown, question?: string): string {
  const record = asRecord(data);
  const indexed = (record.indexed && typeof record.indexed === "object" ? record.indexed : record) as Record<
    string,
    unknown
  >;
  const bySource = Array.isArray(indexed.bySource) ? (indexed.bySource as IndexSourceCount[]) : [];
  const connected = Array.isArray(indexed.connectedSystems)
    ? (indexed.connectedSystems as string[])
    : Array.isArray(record.connectors)
      ? (record.connectors as string[])
      : [];
  const driveRow = bySource.find((row) => /google drive/i.test(row.source));
  const msSources = bySource.filter((row) => !/google drive/i.test(row.source));
  const msTotal = msSources.reduce((sum, row) => sum + row.count, 0);
  const driveConnected =
    indexed.driveConnected === true ||
    Boolean(driveRow) ||
    connected.some((row) => /google drive|drive files|conn_google_drive/i.test(row));
  const driveReliable =
    driveRow != null && Number.isFinite(driveRow.count) && indexed.driveCountReliable !== false;
  const q = String(question ?? "").toLowerCase();

  if (!Number.isFinite(msTotal)) {
    return "I can see your indexed files, but I don't have a reliable count right now.";
  }

  if (/\b(google )?drive\b/.test(q) && !/versus|vs|sharepoint or|or drive/.test(q)) {
    if (driveReliable && driveRow) {
      return `There are ${driveRow.count} indexed Google Drive ${driveRow.count === 1 ? "document" : "documents"} I can count.`;
    }
    if (driveConnected) {
      return `Google Drive is connected, but I don't have a reliable Drive file count in this index yet. I can see ${msTotal} indexed document${msTotal === 1 ? "" : "s"} from ${sourceList(msSources)}.`;
    }
    return `I don't have a Google Drive count in the index I can see. I can see ${msTotal} indexed document${msTotal === 1 ? "" : "s"} from ${sourceList(msSources)}.`;
  }

  const sourceAsk = bySource.find((row) => q.includes(row.source.toLowerCase()) && !/google drive/i.test(row.source));
  if (sourceAsk) {
    return `There are ${sourceAsk.count} indexed ${sourceAsk.source} ${sourceAsk.count === 1 ? "document" : "documents"} you can see.`;
  }
  if (/\bwhere|most|from\b/.test(q) && msSources[0]) {
    const rest = msSources
      .slice(1, 4)
      .map((row) => `${row.source} (${row.count})`)
      .join(", ");
    const driveNote = driveReliable && driveRow
      ? ` Google Drive is ${driveRow.count}.`
      : driveConnected
        ? " Google Drive is connected, but I don't have a reliable Drive count yet."
        : "";
    return `Most are from ${msSources[0].source} (${msSources[0].count})${rest ? `. Also ${rest}` : ""}.${driveNote}`;
  }
  if (/\btype\b/.test(q) && Array.isArray(indexed.byType) && (indexed.byType as IndexTypeCount[]).length) {
    const types = (indexed.byType as IndexTypeCount[])
      .slice(0, 4)
      .map((row) => `${row.count} ${row.type}`)
      .join(", ");
    return `By file type: ${types}.`;
  }
  const breakdown = msSources.slice(0, 4).map((row) => `${row.source} ${row.count}`).join(", ");
  if (driveReliable && driveRow) {
    const combined = msTotal + driveRow.count;
    return `You currently have ${msTotal} indexed document${msTotal === 1 ? "" : "s"} from ${
      breakdown || "Microsoft sources"
    }, plus ${driveRow.count} from Google Drive — ${combined} in total that I can count.`;
  }
  if (driveConnected) {
    return `You currently have ${msTotal} document${msTotal === 1 ? "" : "s"} indexed that I can count${
      breakdown ? ` — ${breakdown}` : ""
    }. Google Drive is connected, but I don't have a reliable Drive file count yet, so I won't guess a combined total.`;
  }
  return `You currently have ${msTotal} document${msTotal === 1 ? "" : "s"} indexed that you can see${
    breakdown ? ` — ${breakdown}` : ""
  }.`;
}

function sourceList(rows: IndexSourceCount[]): string {
  if (!rows.length) return "the Microsoft index";
  if (rows.length === 1) return rows[0]!.source;
  return `${rows.slice(0, -1).map((row) => row.source).join(", ")} and ${rows[rows.length - 1]!.source}`;
}

function verbaliseSummary(data: unknown, question?: string): string {
  const record = asRecord(data);
  if (record.indexed) return verbaliseIndexStats(data, question);
  return verbaliseIndexStats(data, question);
}

function verbaliseConnectors(data: unknown): string {
  const connected = Array.isArray(asRecord(data).connected) ? (asRecord(data).connected as string[]) : [];
  if (!connected.length) {
    return "I can search documents you already have access to. No other business systems are connected right now.";
  }
  const listed =
    connected.length === 1 ? connected[0] : `${connected.slice(0, -1).join(", ")}, and ${connected[connected.length - 1]}`;
  return `These systems are connected: ${listed}.`;
}

function verbaliseCapabilities(data: unknown): string {
  const record = asRecord(data);
  const help = Array.isArray(record.canHelpWith) ? (record.canHelpWith as string[]) : [];
  const connected = Array.isArray(record.connectedSystems) ? (record.connectedSystems as string[]) : [];
  const intro = "I can help with the connected systems you are allowed to use.";
  const helpLine = help.length ? ` That includes ${help.slice(0, 4).join("; ")}.` : "";
  const connLine = connected.length
    ? ` Currently connected: ${
        connected.length === 1
          ? connected[0]
          : `${connected.slice(0, -1).join(", ")}, and ${connected[connected.length - 1]}`
      }.`
    : " I will only use systems that are connected.";
  return `${intro}${helpLine}${connLine}`;
}

function verbaliseAutomations(data: unknown): string {
  const record = asRecord(data);
  const active = Array.isArray(record.active) ? (record.active as string[]) : [];
  const paused = Array.isArray(record.paused) ? (record.paused as string[]) : [];
  if (!active.length && !paused.length) return "There are no automations set up for this company.";
  const bits = [];
  if (active.length) bits.push(`${active.length} active (${active.slice(0, 3).join(", ")})`);
  if (paused.length) bits.push(`${paused.length} paused`);
  return `Automations: ${bits.join("; ")}.`;
}

function verbaliseSync(data: unknown): string {
  const last = asRecord(data).lastSyncAt;
  if (typeof last !== "string" || !last) return "I don't have a last-sync time for the index yet.";
  return `The index I can see was last updated ${last}.`;
}

export function extractRealCounts(data: unknown): number[] {
  const raw = JSON.stringify(data ?? {});
  return [...raw.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter((n) => Number.isFinite(n));
}

export function inventedCount(text: string, data: unknown): boolean {
  const allowed = new Set(extractRealCounts(data).map(String));
  if (!allowed.size) {
    return /\b\d{2,}\b/.test(text);
  }
  const mentioned = [...text.matchAll(/\b\d+\b/g)].map((match) => match[0]);
  return mentioned.some((token) => !allowed.has(token) && Number(token) > 1);
}

export function advertisedMissingConnector(text: string, connected: string[]): boolean {
  const hay = text.toLowerCase();
  const checks: Array<{ label: RegExp; present: boolean }> = [
    { label: /xero/, present: connected.some((row) => /xero/i.test(row)) },
    { label: /sharepoint/, present: connected.some((row) => /sharepoint/i.test(row)) },
    { label: /google drive/, present: connected.some((row) => /google drive|drive files/i.test(row)) },
    { label: /onedrive/, present: connected.some((row) => /onedrive/i.test(row)) },
  ];
  return checks.some((row) => row.label.test(hay) && !row.present && /\b(connected|i can|access to|from)\b/i.test(text));
}

export async function connectedConnectorIds(env: Pick<Env, "DB">, companyId: string): Promise<string[]> {
  try {
    return await listConnectedConnectorIds(env as Env, companyId);
  } catch {
    return [];
  }
}

export function resetSystemMetaCache(): void {
  cache.clear();
}
