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
import {
  isAiChannelEnabled,
  revokeRefreshTokensForUser,
  setAiChannelEnabled,
} from "../auth/mcp-oauth";
import { nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
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
          (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '/api/gateway/v1/mcp', ?, ?, ?)`,
      )
      .bind(
        `ai_${companyId}_${channel}`,
        companyId,
        channel,
        AI_CHANNEL_LABELS[channel],
        channel === "whatsapp" ? "coming_soon" : "ready_to_connect",
        `${AI_CHANNEL_LABELS[channel]} is available after company approval. Individuals connect with INFRA OAuth.`,
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
  void employeeMustNotSeeSharedToken({ role, isPlatformAdmin: input.user.isPlatformAdmin });

  const rows = await db
    .prepare(`SELECT * FROM ai_client_connections WHERE company_id = ? ORDER BY client_type ASC`)
    .bind(input.companyId)
    .all();

  const userRows = await db
    .prepare(`SELECT * FROM ai_user_connections WHERE company_id = ? AND user_id = ?`)
    .bind(input.companyId, input.user.userId)
    .all();
  const mine = new Map(
    (userRows.results ?? []).map((row) => [String(row.client_type), row]),
  );

  const counts = await db
    .prepare(
      `SELECT client_type, COUNT(*) AS count FROM ai_user_connections
       WHERE company_id = ? AND status = 'connected' GROUP BY client_type`,
    )
    .bind(input.companyId)
    .all();
  const countByChannel = new Map(
    (counts.results ?? []).map((row) => [String(row.client_type), Number(row.count ?? 0)]),
  );

  const mcpEndpoint = infraMcpGatewayUrl({ INFRA_PUBLIC_API_URL: input.apiBase } as never, input.apiBase);
  const issuer = input.apiBase.replace(/\/$/, "");

  return Promise.all(
    (rows.results ?? []).map(async (row) => {
      const channel = String(row.client_type) as AiChannel;
      const approved = await isAiChannelEnabled(db, input.companyId, channel);
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
              connectedAs: input.user.email,
              connectedAt: mineRow.created_at ? String(mineRow.created_at) : null,
              lastSeen: mineRow.last_used_at ? String(mineRow.last_used_at) : null,
            }
          : null,
        canApprove,
        canConnect: connectDecision.allowed && String(row.status) !== "coming_soon",
        canDisableCompany: canApprove && approved,
        mcpEndpoint,
        authorizationUrl: `${issuer}/oauth/authorize?company=${encodeURIComponent(input.companySlug)}&channel=${channel}`,
      };
    }),
  );
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
  await setAiChannelEnabled(db, input.companyId, input.channel, input.approved, input.actor.email);

  if (!input.approved) {
    const users = await db
      .prepare(
        `SELECT user_id FROM ai_user_connections
         WHERE company_id = ? AND client_type = ? AND status = 'revoked'`,
      )
      .bind(input.companyId, input.channel)
      .all();
    for (const row of users.results ?? []) {
      await revokeRefreshTokensForUser(db, String(row.user_id), input.companyId);
    }
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
  _db: D1Database,
  input: {
    companyId: string;
    channel: string;
    actor: SessionUser;
    companySlug?: string;
    apiBase?: string;
  },
): Promise<
  | { ok: true; connectedAs: string; status: string; authorizationUrl: string }
  | { ok: false; error: string; status: 400 | 403 }
> {
  if (!isAiChannel(input.channel) || input.channel === "whatsapp") {
    return {
      ok: false,
      error: input.channel === "whatsapp" ? "WhatsApp is coming soon" : "Unsupported AI channel",
      status: 400,
    };
  }
  const user = await getUserById(_db, input.actor.userId);
  const membership = await _db
    .prepare(`SELECT role, status FROM company_memberships WHERE company_id = ? AND user_id = ?`)
    .bind(input.companyId, input.actor.userId)
    .first<{ role?: string; status?: string }>();
  const approved = await isAiChannelEnabled(_db, input.companyId, input.channel);
  const decision = canConnectApprovedUserChannel({
    role: membership?.role ?? null,
    companyApproved: approved,
    membershipStatus: membership?.status ?? "disabled",
    userStatus: user?.status ?? "disabled",
  });
  if (!decision.allowed) {
    return { ok: false, error: decision.reason ?? "Not permitted", status: 403 };
  }
  const issuer = (input.apiBase ?? "").replace(/\/$/, "");
  const slug = input.companySlug ?? input.companyId;
  return {
    ok: true,
    connectedAs: input.actor.email,
    status: "ready_to_connect",
    authorizationUrl: `${issuer}/oauth/authorize?company=${encodeURIComponent(slug)}&channel=${input.channel}`,
  };
}

export async function disconnectUserAiChannel(
  db: D1Database,
  input: { companyId: string; channel: string; actor: SessionUser },
): Promise<{ ok: true } | { ok: false; error: string; status: 404 }> {
  const row = await db
    .prepare(`SELECT * FROM ai_user_connections WHERE company_id = ? AND user_id = ? AND client_type = ?`)
    .bind(input.companyId, input.actor.userId, input.channel)
    .first();
  if (!row) return { ok: false, error: "Connection not found", status: 404 };
  const now = nowIso();
  await revokeRefreshTokensForUser(db, input.actor.userId, input.companyId);
  await db
    .prepare(
      `UPDATE ai_user_connections
       SET status = 'revoked', updated_at = ?
       WHERE company_id = ? AND user_id = ? AND client_type = ?`,
    )
    .bind(now, input.companyId, input.actor.userId, input.channel)
    .run();
  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "user_ai.disconnected",
    actor: input.actor.email,
    resourceType: "user_ai_connection",
    resourceId: input.channel,
    detail: { via: "infra_oauth" },
  });
  return { ok: true };
}
