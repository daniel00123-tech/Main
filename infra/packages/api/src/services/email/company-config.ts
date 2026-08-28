import type {
  CompanyEmailConfig,
  EmailHealthStatus,
  EmailProviderKind,
  TransactionalEmailType,
} from "@infra/shared";

export type CompanyEmailConfigRow = {
  id: string;
  company_id: string;
  provider: string;
  sender_address: string;
  sender_display_name: string;
  enabled: number;
  allowed_types_json: string;
  health_status: string;
  last_sent_at: string | null;
  last_error_category: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: CompanyEmailConfigRow): CompanyEmailConfig {
  let allowedTypes: TransactionalEmailType[] = [];
  try {
    const parsed = JSON.parse(row.allowed_types_json) as unknown;
    if (Array.isArray(parsed)) {
      allowedTypes = parsed.filter((value): value is TransactionalEmailType => typeof value === "string");
    }
  } catch {
    allowedTypes = [];
  }

  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider as EmailProviderKind,
    senderAddress: row.sender_address,
    senderDisplayName: row.sender_display_name,
    enabled: row.enabled === 1,
    allowedTypes,
    healthStatus: row.health_status as EmailHealthStatus,
    lastSentAt: row.last_sent_at,
    lastErrorCategory: row.last_error_category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCompanyEmailConfig(
  db: D1Database,
  companyId: string,
): Promise<CompanyEmailConfig | null> {
  const row = await db
    .prepare("SELECT * FROM company_email_config WHERE company_id = ? LIMIT 1")
    .bind(companyId)
    .first<CompanyEmailConfigRow>();
  return row ? mapRow(row) : null;
}

export async function updateCompanyEmailHealth(
  db: D1Database,
  companyId: string,
  input: {
    healthStatus?: EmailHealthStatus;
    lastSentAt?: string | null;
    lastErrorCategory?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE company_email_config
       SET health_status = COALESCE(?, health_status),
           last_sent_at = COALESCE(?, last_sent_at),
           last_error_category = ?,
           updated_at = ?
       WHERE company_id = ?`,
    )
    .bind(
      input.healthStatus ?? null,
      input.lastSentAt ?? null,
      input.lastErrorCategory ?? null,
      now,
      companyId,
    )
    .run();
}

export function normaliseSenderAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function senderMatchesAllowlist(
  config: CompanyEmailConfig,
  requestedSender?: string | null,
): boolean {
  const approved = normaliseSenderAddress(config.senderAddress);
  if (!requestedSender) return true;
  return normaliseSenderAddress(requestedSender) === approved;
}
