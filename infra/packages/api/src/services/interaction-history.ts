import { newId, nowIso } from "../db/mappers";
import { redactSecretFields, sanitizeForLog } from "./secrets";
import { mapChannel } from "./quality-auditor";

const SENSITIVE_HEADER_KEYS = /^(authorization|cookie|x-api-key|x-auth|proxy-authorization)$/i;

export function redactInteractionPayload(value: unknown): unknown {
  const sanitized = sanitizeForLog(value);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return redactHeaders(redactSecretFields(sanitized as Record<string, unknown>));
  }
  return sanitized;
}

function redactHeaders(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_HEADER_KEYS.test(key) || /header/i.test(key) && typeof item === "object") {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const headers = item as Record<string, unknown>;
        const next: Record<string, unknown> = {};
        for (const [header, headerValue] of Object.entries(headers)) {
          next[header] = SENSITIVE_HEADER_KEYS.test(header) ? "[redacted]" : headerValue;
        }
        out[key] = next;
        continue;
      }
    }
    if (SENSITIVE_HEADER_KEYS.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out[key] = redactHeaders(item as Record<string, unknown>);
    } else {
      out[key] = item;
    }
  }
  return out;
}

export async function logInteractionAccess(
  db: D1Database,
  input: {
    interactionId: string;
    companyId: string;
    viewerUserId: string;
    viewerEmail: string;
    purpose?: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO interaction_access_log (
         id, interaction_id, company_id, viewer_user_id, viewer_email, purpose, viewed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("ial"),
      input.interactionId,
      input.companyId,
      input.viewerUserId,
      input.viewerEmail,
      input.purpose ?? "admin_inspect",
      nowIso(),
    )
    .run();
}

export async function listInteractionHistory(
  db: D1Database,
  filters: {
    companyId?: string;
    userId?: string;
    channel?: string;
    provider?: string;
    success?: boolean;
    tool?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {},
) {
  const limit = Math.min(filters.limit ?? 75, 200);
  const result = await db
    .prepare(
      `SELECT i.*, c.name AS company_name, c.slug AS company_slug,
              u.email AS user_email, u.display_name AS user_name
       FROM interactions i
       LEFT JOIN companies c ON c.id = i.company_id
       LEFT JOIN users u ON u.id = i.actor_id
       WHERE (? IS NULL OR i.company_id = ?)
         AND (? IS NULL OR i.actor_id = ?)
         AND (? IS NULL OR i.client_kind = ? OR i.client_kind = ?)
         AND (? IS NULL OR i.created_at >= ?)
         AND (? IS NULL OR i.created_at < ?)
         AND (? IS NULL OR i.status = ? OR (? = 'success' AND i.status = 'completed') OR (? = 'failure' AND i.status = 'error'))
       ORDER BY i.created_at DESC
       LIMIT ?`,
    )
    .bind(
      filters.companyId ?? null,
      filters.companyId ?? null,
      filters.userId ?? null,
      filters.userId ?? null,
      filters.channel ?? null,
      filters.channel ?? null,
      channelAlias(filters.channel),
      filters.from ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.to ?? null,
      successStatus(filters.success),
      successStatus(filters.success),
      filters.success === true ? "success" : null,
      filters.success === false ? "failure" : null,
      limit,
    )
    .all<Record<string, unknown>>();

  const rows = result.results ?? [];
  const ids = rows.map((row) => String(row.id));
  const usageByInteraction = await loadUsageSummaries(db, ids, filters);

  return rows
    .map((row) => {
      const usage = usageByInteraction.get(String(row.id));
      if (filters.tool && !usage?.tools.some((tool) => tool.includes(filters.tool!))) {
        return null;
      }
      if (filters.provider && !usage?.providers.includes(filters.provider)) {
        return null;
      }
      return {
        id: String(row.id),
        companyId: String(row.company_id),
        companyName: row.company_name ? String(row.company_name) : null,
        companySlug: row.company_slug ? String(row.company_slug) : null,
        userId: row.actor_id ? String(row.actor_id) : null,
        userEmail: row.user_email ? String(row.user_email) : null,
        userName: row.user_name ? String(row.user_name) : String(row.actor_id),
        channel: mapChannel(String(row.client_kind)),
        clientKind: String(row.client_kind),
        label: String(row.label),
        status: String(row.status),
        success: String(row.status) !== "error",
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        operationCount: Number(row.operation_count ?? 0),
        customerChargeCents: Number(row.customer_charge_cents ?? 0),
        providerCostCents: row.provider_cost_cents == null ? null : Number(row.provider_cost_cents),
        providerCostKnown: Number(row.provider_cost_known ?? 0) === 1,
        tools: usage?.tools ?? [],
        providers: usage?.providers ?? [],
        latencyMs: usage?.latencyMs ?? null,
        inputType: usage?.inputType ?? (mapChannel(String(row.client_kind)) === "whatsapp" ? "text" : null),
        originatedAsVoice: usage?.inputType === "voice",
      };
    })
    .filter(Boolean);
}

export async function getInteractionDetail(
  db: D1Database,
  interactionId: string,
) {
  const row = await db
    .prepare(
      `SELECT i.*, c.name AS company_name, c.slug AS company_slug,
              u.email AS user_email, u.display_name AS user_name
       FROM interactions i
       LEFT JOIN companies c ON c.id = i.company_id
       LEFT JOIN users u ON u.id = i.actor_id
       WHERE i.id = ?`,
    )
    .bind(interactionId)
    .first<Record<string, unknown>>();
  if (!row) return null;

  const usage = await db
    .prepare(
      `SELECT * FROM usage_records WHERE interaction_id = ? ORDER BY recorded_at ASC`,
    )
    .bind(interactionId)
    .all<Record<string, unknown>>();

  const quality = await db
    .prepare(
      `SELECT id, category, severity, confidence, status, occurrence_count, evidence_json
       FROM quality_issues WHERE last_interaction_id = ? ORDER BY last_seen_at DESC`,
    )
    .bind(interactionId)
    .all<Record<string, unknown>>();

  const gateway = await db
    .prepare(
      `SELECT id, correlation_id, request_id, tool_name, action, status, error_code,
              error_message, latency_ms, http_status, created_at, metadata_json
       FROM gateway_requests
       WHERE company_id = ? AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC LIMIT 50`,
    )
    .bind(
      String(row.company_id),
      String(row.created_at),
      String(row.updated_at ?? row.created_at),
    )
    .all<Record<string, unknown>>();

  const operations = (usage.results ?? []).map((item) => ({
    id: String(item.id),
    toolName: item.tool_name ? String(item.tool_name) : null,
    action: item.action ? String(item.action) : null,
    success: Number(item.success) === 1,
    durationMs: item.duration_ms == null ? null : Number(item.duration_ms),
    customerChargeCents: Number(item.customer_charge_cents ?? 0),
    providerCostCents: item.underlying_cost_cents == null ? null : Number(item.underlying_cost_cents),
    costBasis: item.cost_basis ? String(item.cost_basis) : "unknown",
    provider: item.resource_type ? String(item.resource_type) : null,
    requestId: item.request_id ? String(item.request_id) : null,
    correlationId: item.correlation_id ? String(item.correlation_id) : null,
    recordedAt: String(item.recorded_at),
    metadata: redactInteractionPayload(parseJson(item.metadata_json)),
  }));

  return {
    id: String(row.id),
    companyId: String(row.company_id),
    companyName: row.company_name ? String(row.company_name) : null,
    companySlug: row.company_slug ? String(row.company_slug) : null,
    userId: row.actor_id ? String(row.actor_id) : null,
    userEmail: row.user_email ? String(row.user_email) : null,
    userName: row.user_name ? String(row.user_name) : null,
    channel: mapChannel(String(row.client_kind)),
    label: String(row.label),
    status: String(row.status),
    inputType: whatsappInputType(operations.map((item) => item.metadata)),
    originatedAsVoice: whatsappInputType(operations.map((item) => item.metadata)) === "voice",
    transcript: whatsappTranscript(operations.map((item) => item.metadata)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    customerChargeCents: Number(row.customer_charge_cents ?? 0),
    providerCostCents: row.provider_cost_cents == null ? null : Number(row.provider_cost_cents),
    request: redactInteractionPayload({
      actorType: row.actor_type,
      actorId: row.actor_id,
      clientKind: row.client_kind,
      label: row.label,
    }),
    response: redactInteractionPayload({
      status: row.status,
      operationCount: row.operation_count,
    }),
    tools: operations.map((item) => ({
      name: item.toolName,
      action: item.action,
      success: item.success,
      resultMetadata: item.metadata,
    })),
    timing: {
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      latencyMs: operations.reduce((max, item) => Math.max(max, item.durationMs ?? 0), 0) || null,
    },
    providerCost: {
      customerChargeCents: Number(row.customer_charge_cents ?? 0),
      providerCostCents: row.provider_cost_cents == null ? null : Number(row.provider_cost_cents),
      known: Number(row.provider_cost_known ?? 0) === 1,
    },
    traceIds: {
      interactionId: String(row.id),
      mcpSessionId: row.mcp_session_id ? String(row.mcp_session_id) : null,
      requestIds: operations.map((item) => item.requestId).filter(Boolean),
      correlationIds: operations.map((item) => item.correlationId).filter(Boolean),
    },
    qualityFlags: (quality.results ?? []).map((item) => ({
      id: String(item.id),
      category: String(item.category),
      severity: String(item.severity),
      confidence: Number(item.confidence),
      status: String(item.status),
      occurrenceCount: Number(item.occurrence_count ?? 1),
    })),
    operations,
    gateway: (gateway.results ?? []).map((item) => ({
      id: String(item.id),
      correlationId: item.correlation_id ? String(item.correlation_id) : null,
      requestId: item.request_id ? String(item.request_id) : null,
      toolName: item.tool_name ? String(item.tool_name) : null,
      status: String(item.status),
      errorCode: item.error_code ? String(item.error_code) : null,
      errorMessage: item.error_message
        ? String(redactInteractionPayload(String(item.error_message)))
        : null,
      latencyMs: item.latency_ms == null ? null : Number(item.latency_ms),
      httpStatus: item.http_status == null ? null : Number(item.http_status),
      createdAt: String(item.created_at),
    })),
  };
}

async function loadUsageSummaries(
  db: D1Database,
  interactionIds: string[],
  filters: { tool?: string; provider?: string },
) {
  const map = new Map<
    string,
    { tools: string[]; providers: string[]; latencyMs: number | null; inputType: string | null }
  >();
  if (interactionIds.length === 0) return map;
  const placeholders = interactionIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT interaction_id, tool_name, resource_type, duration_ms, metadata_json
       FROM usage_records
       WHERE interaction_id IN (${placeholders})`,
    )
    .bind(...interactionIds)
    .all<{
      interaction_id: string;
      tool_name: string | null;
      resource_type: string | null;
      duration_ms: number | null;
      metadata_json?: string | null;
    }>();

  for (const row of result.results ?? []) {
    const current = map.get(row.interaction_id) ?? {
      tools: [],
      providers: [],
      latencyMs: null,
      inputType: null,
    };
    if (row.tool_name && !current.tools.includes(row.tool_name)) current.tools.push(row.tool_name);
    if (row.resource_type && !current.providers.includes(row.resource_type)) {
      current.providers.push(row.resource_type);
    }
    const duration = row.duration_ms == null ? null : Number(row.duration_ms);
    if (duration != null) {
      current.latencyMs = Math.max(current.latencyMs ?? 0, duration);
    }
    const meta = parseJson(row.metadata_json ?? null);
    const kind = typeof meta?.inputType === "string" ? meta.inputType : typeof meta?.inputKind === "string" ? meta.inputKind : null;
    if (kind && !current.inputType) current.inputType = kind;
    map.set(row.interaction_id, current);
  }
  void filters;
  return map;
}

function channelAlias(channel?: string): string | null {
  if (!channel) return null;
  if (channel === "chatgpt_mcp") return "chatgpt";
  if (channel === "claude_mcp") return "claude";
  return channel;
}

function successStatus(success?: boolean): string | null {
  if (success === true) return "completed";
  if (success === false) return "error";
  return null;
}

function parseJson(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function whatsappInputType(metadatas: unknown[]): string | null {
  for (const item of metadatas) {
    const meta = asMeta(item);
    const kind = meta.inputType ?? meta.inputKind;
    if (kind === "voice" || kind === "button" || kind === "text") return String(kind);
  }
  return null;
}

function whatsappTranscript(metadatas: unknown[]): string | null {
  for (const item of metadatas) {
    const meta = asMeta(item);
    const transcript = meta.transcript;
    if (typeof transcript === "string" && transcript.trim()) return transcript.slice(0, 4000);
  }
  return null;
}
