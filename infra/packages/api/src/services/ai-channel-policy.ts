import {
  AI_CHANNEL_LABELS,
  canConnectApprovedUserChannel,
  canManageCompanyAiPolicy,
  employeeMustNotSeeSharedToken,
  isAiChannel,
  type AiChannel,
} from "@infra/shared";
import type { SessionUser } from "../auth/session";
import { getUserById } from "../auth/users";
import { newId, nowIso } from "../db/mappers";
import { listMcpEnvironments, recordAuditEvent } from "./control-plane";
import { createServiceIdentity, setServiceIdentityStatus } from "./service-identities";
import { hashServiceToken } from "./service-identities";
import { infraMcpGatewayUrl } from "./public-urls";

export { canConnectApprovedUserChannel, canManageCompanyAiPolicy, employeeMustNotSeeSharedToken };

export type CompanyAiChannelView = {
  channel: AiChannel;
  displayName: string;
  companyApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  status: string;
  connectedUserCount: number;
  userConnection: {
    status: string;
    connectedAs: string | null;
    connectedAt: string | null;
    lastSeen: string | null;
  } | null;
  canApprove: boolean;
  canConnect: boolean;
  canDisableCompany: boolean;
  mcpEndpoint: string;
  authorizationUrl: string;
};

async function ensureChannelRows(db: D1Database, companyId: string) {
  const now = nowIso();
  for (const channel of ["chatgpt", "claude", "whatsapp"] as const) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ai_client_connections
          (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at, approved)
         VALUES (?, ?, ?, ?, ?, '/api/gateway/v1/mcp', ?, ?, ?, 0)`,
      )
      .bind(
        `ai_${companyId}_${channel}`,
        companyId,
        channel,
        AI_CHANNEL_LABELS[channel],
        channel === "whatsapp" ? "coming_soon" : "ready_to_connect",
        `${AI_CHANNEL_LABELS[channel]} is available after company approval. Individuals connect their own identity.`,
        now,
        now,
      )
      .run();
  }
}

export async function listCompanyAiChannels(
  db: D1Database,
  input: {
    companyId: string;
    companySlug: string;
    user: SessionUser;
    apiBase: string;
  },
): Promise<CompanyAiChannelView[]> {
  await ensureChannelRows(db, input.companyId);
  const role = input.user.memberships.find((item) => item.companyId === input.companyId)?.role ?? null;
  const canApprove = canManageCompanyAiPolicy(role, input.user.isPlatformAdmin);
  const hideToken = employeeMustNotSeeSharedToken({ role, isPlatformAdmin: input.user.isPlatformAdmin });

  const rows = await db
    .prepare(`SELECT * FROM ai_client_connections WHERE company_id = ? ORDER BY client_type ASC`)
    .bind(input.companyId)
    .all();

  const userRows = await db
    .prepare(`SELECT * FROM user_ai_connections WHERE company_id = ? AND user_id = ?`)
    .bind(input.companyId, input.user.userId)
    .all();
  const mine = new Map(
    (userRows.results ?? []).map((row) => [String(row.channel), row]),
  );

  const counts = await db
    .prepare(
      `SELECT channel, COUNT(*) AS count FROM user_ai_connections
       WHERE company_id = ? AND status = 'connected' GROUP BY channel`,
    )
    .bind(input.companyId)
    .all();
  const countByChannel = new Map(
    (counts.results ?? []).map((row) => [String(row.channel), Number(row.count ?? 0)]),
  );

  const mcpEndpoint = infraMcpGatewayUrl({ INFRA_PUBLIC_API_URL: input.apiBase } as never, input.apiBase);
  void hideToken;

  return (rows.results ?? []).map((row) => {
    const channel = String(row.client_type) as AiChannel;
    const approved = Number(row.approved ?? 0) === 1;
    const mineRow = mine.get(channel);
    const connectDecision = canConnectApprovedUserChannel({
      role,
      companyApproved: approved,
      membershipStatus: "active",
      userStatus: "active",
    });
    return {
      channel,
      displayName: String(row.display_name),
      companyApproved: approved,
      approvedBy: row.approved_by ? String(row.approved_by) : null,
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      status: String(row.status),
      connectedUserCount: canApprove ? countByChannel.get(channel) ?? 0 : 0,
      userConnection: mineRow
        ? {
            status: String(mineRow.status),
            connectedAs: mineRow.external_identity ? String(mineRow.external_identity) : null,
            connectedAt: mineRow.connected_at ? String(mineRow.connected_at) : null,
            lastSeen: mineRow.last_seen ? String(mineRow.last_seen) : null,
          }
        : null,
      canApprove,
      canConnect: connectDecision.allowed && String(row.status) !== "coming_soon",
      canDisableCompany: canApprove && approved,
      mcpEndpoint,
      authorizationUrl: `${input.apiBase.replace(/\/$/, "")}/api/oauth/ai/authorize?company=${encodeURIComponent(input.companySlug)}&channel=${channel}`,
    };
  });
}

export async function setCompanyAiChannelApproved(
  db: D1Database,
  input: {
    companyId: string;
    channel: string;
    approved: boolean;
    actor: SessionUser;
  },
): Promise<{ ok: true } | { ok: false; error: string; status: 400 | 403 }> {
  if (!isAiChannel(input.channel)) return { ok: false, error: "Unsupported AI channel", status: 400 };
  const role = input.actor.memberships.find((item) => item.companyId === input.companyId)?.role ?? null;
  if (!canManageCompanyAiPolicy(role, input.actor.isPlatformAdmin)) {
    return { ok: false, error: "Company administrator access required", status: 403 };
  }
  await ensureChannelRows(db, input.companyId);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE ai_client_connections
       SET approved = ?, approved_by = ?, approved_at = ?,
           status = CASE WHEN ? = 1 THEN status ELSE 'ready_to_connect' END,
           updated_at = ?
       WHERE company_id = ? AND client_type = ?`,
    )
    .bind(
      input.approved ? 1 : 0,
      input.approved ? input.actor.email : null,
      input.approved ? now : null,
      input.approved ? 1 : 0,
      now,
      input.companyId,
      input.channel,
    )
    .run();

  if (!input.approved) {
    const users = await db
      .prepare(`SELECT * FROM user_ai_connections WHERE company_id = ? AND channel = ? AND status = 'connected'`)
      .bind(input.companyId, input.channel)
      .all();
    for (const row of users.results ?? []) {
      if (row.service_identity_id) {
        await setServiceIdentityStatus(db, String(row.service_identity_id), "disabled");
      }
    }
    await db
      .prepare(
        `UPDATE user_ai_connections
         SET status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE company_id = ? AND channel = ? AND status = 'connected'`,
      )
      .bind(now, now, input.companyId, input.channel)
      .run();
  }

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: input.approved ? "ai_channel.enabled" : "ai_channel.disabled",
    actor: input.actor.email,
    resourceType: "ai_channel",
    resourceId: input.channel,
    detail: { approved: input.approved },
  });
  return { ok: true };
}

export async function connectUserAiChannel(
  envDb: D1Database,
  input: {
    companyId: string;
    channel: string;
    actor: SessionUser;
  },
): Promise<
  | { ok: true; connectedAs: string; status: string; authorizationUrl?: string }
  | { ok: false; error: string; status: 400 | 403 }
> {
  if (!isAiChannel(input.channel) || input.channel === "whatsapp") {
    return { ok: false, error: input.channel === "whatsapp" ? "WhatsApp is coming soon" : "Unsupported AI channel", status: 400 };
  }
  const user = await getUserById(envDb, input.actor.userId);
  const membership = await envDb
    .prepare(`SELECT role, status FROM company_memberships WHERE company_id = ? AND user_id = ?`)
    .bind(input.companyId, input.actor.userId)
    .first<{ role?: string; status?: string }>();
  const channel = await envDb
    .prepare(`SELECT approved, status FROM ai_client_connections WHERE company_id = ? AND client_type = ?`)
    .bind(input.companyId, input.channel)
    .first<{ approved?: number; status?: string }>();

  const decision = canConnectApprovedUserChannel({
    role: membership?.role ?? null,
    companyApproved: Number(channel?.approved ?? 0) === 1,
    membershipStatus: membership?.status ?? "disabled",
    userStatus: user?.status ?? "disabled",
  });
  if (!decision.allowed) {
    return { ok: false, error: decision.reason ?? "Not permitted", status: 403 };
  }

  const now = nowIso();
  const connectedAs = input.actor.email;
  const mcps = await listMcpEnvironments(envDb, input.companyId);
  const created = await createServiceIdentity(envDb, {
    companyId: input.companyId,
    name: `${AI_CHANNEL_LABELS[input.channel]} · ${connectedAs}`,
    identityType: input.channel,
    mcpEnvironmentId: mcps[0]?.id ?? null,
    boundUserId: input.actor.userId,
  });

  const existing = await envDb
    .prepare(`SELECT service_identity_id FROM user_ai_connections WHERE company_id = ? AND user_id = ? AND channel = ?`)
    .bind(input.companyId, input.actor.userId, input.channel)
    .first<{ service_identity_id?: string }>();
  if (existing?.service_identity_id) {
    await setServiceIdentityStatus(envDb, String(existing.service_identity_id), "disabled");
  }

  await envDb
    .prepare(
      `INSERT INTO user_ai_connections (
        id, company_id, user_id, channel, external_identity, status,
        connected_at, last_seen, revoked_at, service_identity_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(company_id, user_id, channel) DO UPDATE SET
        external_identity = excluded.external_identity,
        status = 'connected',
        connected_at = excluded.connected_at,
        last_seen = excluded.last_seen,
        revoked_at = NULL,
        service_identity_id = excluded.service_identity_id,
        updated_at = excluded.updated_at`,
    )
    .bind(
      newId("uai"),
      input.companyId,
      input.actor.userId,
      input.channel,
      connectedAs,
      now,
      now,
      created.identity.id,
      now,
      now,
    )
    .run();

  await recordAuditEvent(envDb, {
    companyId: input.companyId,
    eventType: "user_ai.connected",
    actor: input.actor.email,
    resourceType: "user_ai_connection",
    resourceId: input.channel,
    detail: { identity: connectedAs, identityId: created.identity.id },
  });

  void created.token;
  return { ok: true, connectedAs, status: "connected" };
}

export async function disconnectUserAiChannel(
  db: D1Database,
  input: { companyId: string; channel: string; actor: SessionUser },
): Promise<{ ok: true } | { ok: false; error: string; status: 404 }> {
  const row = await db
    .prepare(`SELECT * FROM user_ai_connections WHERE company_id = ? AND user_id = ? AND channel = ?`)
    .bind(input.companyId, input.actor.userId, input.channel)
    .first();
  if (!row) return { ok: false, error: "Connection not found", status: 404 };
  if (row.service_identity_id) {
    await setServiceIdentityStatus(db, String(row.service_identity_id), "disabled");
  }
  const now = nowIso();
  await db
    .prepare(
      `UPDATE user_ai_connections
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE company_id = ? AND user_id = ? AND channel = ?`,
    )
    .bind(now, now, input.companyId, input.actor.userId, input.channel)
    .run();
  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "user_ai.disconnected",
    actor: input.actor.email,
    resourceType: "user_ai_connection",
    resourceId: input.channel,
    detail: {},
  });
  return { ok: true };
}

export async function issueAiOauthCode(
  db: D1Database,
  input: { companyId: string; userId: string; channel: string; rawCode: string },
) {
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO ai_oauth_codes (id, company_id, user_id, channel, code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId("aoc"), input.companyId, input.userId, input.channel, await hashServiceToken(input.rawCode), expires, nowIso())
    .run();
}

export async function consumeAiOauthCode(
  db: D1Database,
  rawCode: string,
): Promise<{ companyId: string; userId: string; channel: string } | null> {
  const hash = await hashServiceToken(rawCode);
  const row = await db
    .prepare(
      `SELECT * FROM ai_oauth_codes
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(hash, nowIso())
    .first();
  if (!row) return null;
  await db
    .prepare(`UPDATE ai_oauth_codes SET consumed_at = ? WHERE id = ?`)
    .bind(nowIso(), String(row.id))
    .run();
  return {
    companyId: String(row.company_id),
    userId: String(row.user_id),
    channel: String(row.channel),
  };
}
