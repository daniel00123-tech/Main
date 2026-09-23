import { newId, nowIso } from "../db/mappers";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateSetupTokenValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(bytes);
}

export async function hashSetupToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface PasswordSetupTokenRecord {
  id: string;
  userId: string;
  purpose: string;
  expiresAt: string;
  usedAt: string | null;
}

function rowToToken(row: Record<string, unknown>): PasswordSetupTokenRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    purpose: String(row.purpose),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at ? String(row.used_at) : null,
  };
}

export async function invalidateActiveSetupTokensForUser(
  db: D1Database,
  userId: string,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE password_setup_tokens
       SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL`,
    )
    .bind(now, userId)
    .run();
}

export async function createPasswordSetupToken(
  db: D1Database,
  userId: string,
  purpose: "password_setup" | "password_reset" = "password_setup",
): Promise<{ id: string; token: string; expiresAt: string }> {
  await invalidateActiveSetupTokensForUser(db, userId);

  const token = generateSetupTokenValue();
  const tokenHash = await hashSetupToken(token);
  const id = newId("pst");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  await db
    .prepare(
      `INSERT INTO password_setup_tokens
        (id, user_id, token_hash, purpose, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(id, userId, tokenHash, purpose, expiresAt, createdAt)
    .run();

  return { id, token, expiresAt };
}

export async function findValidSetupToken(
  db: D1Database,
  token: string,
): Promise<PasswordSetupTokenRecord | null> {
  const tokenHash = await hashSetupToken(token);
  const row = await db
    .prepare(
      `SELECT * FROM password_setup_tokens
       WHERE token_hash = ? AND used_at IS NULL`,
    )
    .bind(tokenHash)
    .first();

  if (!row) return null;

  const record = rowToToken(row);
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return record;
}

export async function consumeSetupToken(
  db: D1Database,
  tokenId: string,
): Promise<void> {
  await db
    .prepare("UPDATE password_setup_tokens SET used_at = ? WHERE id = ?")
    .bind(nowIso(), tokenId)
    .run();
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

export function validateNewPassword(password: string): string | null {
  if (password.length < 12) {
    return "Password must be at least 12 characters";
  }
  if (password.length > 128) {
    return "Password must be at most 128 characters";
  }
  return null;
}
