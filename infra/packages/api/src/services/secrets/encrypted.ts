import type { Env } from "../../env";
import { newId, nowIso } from "../../db/mappers";
import {
  CREDENTIAL_ALGORITHM,
  SecretCryptoError,
  SecretStorageUnavailableError,
  buildAad,
  currentKeyVersion,
  decryptCredential,
  encryptCredential,
  readWrappingKeyMaterial,
  wrappingKeyConfigured,
} from "./crypto";
import {
  CredentialSubmissionDisabledError,
  SecretTenantMismatchError,
  type SecretAccessContext,
  type SecretProvider,
  type SecretStoreInput,
  type StoredSecretRef,
} from "./provider";

type CipherRow = {
  id: string;
  company_id: string;
  connector_instance_id: string | null;
  purpose: string;
  algorithm: string;
  key_version: string;
  nonce_b64: string;
  ciphertext_b64: string;
  aad: string;
  status: string;
  predecessor_id: string | null;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
};

/**
 * Production SecretProvider: AES-256-GCM ciphertext in D1, wrapping key
 * only in Worker secrets. MCP Worker bindings stay out of this table.
 */
export class EncryptedD1SecretProvider implements SecretProvider {
  readonly kind = "encrypted_d1";

  constructor(private readonly env: Env) {}

  get submissionEnabled(): boolean {
    return wrappingKeyConfigured(this.env as Record<string, unknown>);
  }

  async store(input: SecretStoreInput): Promise<StoredSecretRef> {
    this.requireKey();
    const reference = newId("sec");
    const createdAt = nowIso();
    const keyVersion = currentKeyVersion(this.env as Record<string, unknown>);
    const aad = buildAad({
      keyVersion,
      companyId: input.companyId,
      purpose: input.purpose,
      connectorInstanceId: input.connectorInstanceId,
      reference,
    });
    const sealed = await encryptCredential({
      plaintext: input.value,
      keyMaterial: this.keyMaterial(keyVersion),
      aad,
    });

    await this.env.DB.prepare(
      `INSERT INTO secret_ciphertexts (
        id, company_id, connector_instance_id, purpose, algorithm, key_version,
        nonce_b64, ciphertext_b64, aad, status, predecessor_id,
        created_at, updated_at, rotated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, NULL)`,
    )
      .bind(
        reference,
        input.companyId,
        input.connectorInstanceId ?? null,
        input.purpose,
        CREDENTIAL_ALGORITHM,
        keyVersion,
        sealed.nonceB64,
        sealed.ciphertextB64,
        aad,
        createdAt,
        createdAt,
      )
      .run();

    return {
      reference,
      companyId: input.companyId,
      purpose: input.purpose,
      connectorInstanceId: input.connectorInstanceId ?? null,
      createdAt,
      rotatedAt: null,
    };
  }

  async resolve(
    reference: string,
    context: SecretAccessContext,
  ): Promise<string | null> {
    if (this.isWorkerBindingRef(reference)) {
      return this.resolveWorkerBinding(reference, context);
    }
    const row = await this.load(reference);
    if (!row) return null;
    // Ownership is checked before decrypt. Plaintext is returned only to the
    // caller and is never cached on the provider.
    this.assertSameCompany(row.company_id, context.companyId);
    if (row.status !== "active") return null;
    if (!row.ciphertext_b64 || !row.nonce_b64) return null;
    const keyMaterial = readWrappingKeyMaterial(
      this.env as Record<string, unknown>,
      row.key_version,
    );
    if (!keyMaterial) {
      throw new SecretStorageUnavailableError();
    }
    return decryptCredential({
      nonceB64: row.nonce_b64,
      ciphertextB64: row.ciphertext_b64,
      keyMaterial,
      aad: row.aad,
    });
  }

  async rotate(
    reference: string,
    value: string,
    context: SecretAccessContext,
  ): Promise<StoredSecretRef> {
    this.requireKey();
    const existing = await this.load(reference);
    if (!existing) throw new SecretTenantMismatchError();
    this.assertSameCompany(existing.company_id, context.companyId);
    if (existing.status === "revoked") {
      throw new SecretCryptoError();
    }

    const keyVersion = currentKeyVersion(this.env as Record<string, unknown>);
    const aad = buildAad({
      keyVersion,
      companyId: existing.company_id,
      purpose: existing.purpose,
      connectorInstanceId: existing.connector_instance_id,
      reference,
    });
    const sealed = await encryptCredential({
      plaintext: value,
      keyMaterial: this.keyMaterial(keyVersion),
      aad,
    });

    const now = nowIso();
    if (existing.ciphertext_b64 && existing.nonce_b64) {
      await this.env.DB.prepare(
        `INSERT INTO secret_ciphertext_history (
          id, secret_id, company_id, algorithm, key_version,
          nonce_b64, ciphertext_b64, aad, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newId("sech"),
          existing.id,
          existing.company_id,
          existing.algorithm,
          existing.key_version,
          existing.nonce_b64,
          existing.ciphertext_b64,
          existing.aad,
          now,
        )
        .run();
    }

    await this.env.DB.prepare(
      `UPDATE secret_ciphertexts
       SET algorithm = ?, key_version = ?, nonce_b64 = ?, ciphertext_b64 = ?,
           aad = ?, status = 'active', predecessor_id = ?,
           rotated_at = ?, updated_at = ?, revoked_at = NULL
       WHERE id = ? AND company_id = ?`,
    )
      .bind(
        CREDENTIAL_ALGORITHM,
        keyVersion,
        sealed.nonceB64,
        sealed.ciphertextB64,
        aad,
        existing.id,
        now,
        now,
        reference,
        context.companyId,
      )
      .run();

    return {
      reference,
      companyId: existing.company_id,
      purpose: existing.purpose as StoredSecretRef["purpose"],
      connectorInstanceId: existing.connector_instance_id,
      createdAt: existing.created_at,
      rotatedAt: now,
    };
  }

  async revoke(reference: string, context: SecretAccessContext): Promise<void> {
    const existing = await this.load(reference);
    if (!existing) throw new SecretTenantMismatchError();
    this.assertSameCompany(existing.company_id, context.companyId);
    const now = nowIso();
    await this.env.DB.prepare(
      `UPDATE secret_ciphertexts
       SET ciphertext_b64 = '', nonce_b64 = '', aad = '', status = 'revoked',
           revoked_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(now, now, reference, context.companyId)
      .run();
    await this.env.DB.prepare(
      `UPDATE secret_ciphertext_history
       SET ciphertext_b64 = '', nonce_b64 = '', aad = ''
       WHERE secret_id = ? AND company_id = ?`,
    )
      .bind(reference, context.companyId)
      .run();
  }

  async exists(
    reference: string,
    context: SecretAccessContext,
  ): Promise<boolean> {
    if (this.isWorkerBindingRef(reference)) {
      return Boolean(await this.resolveWorkerBinding(reference, context));
    }
    const row = await this.load(reference);
    if (!row) return false;
    this.assertSameCompany(row.company_id, context.companyId);
    return row.status === "active" && Boolean(row.ciphertext_b64);
  }

  private requireKey(): void {
    if (!this.submissionEnabled) {
      throw new CredentialSubmissionDisabledError(
        "Secure credential storage is not configured",
      );
    }
  }

  private keyMaterial(version: string): string {
    const material = readWrappingKeyMaterial(
      this.env as Record<string, unknown>,
      version,
    );
    if (!material) throw new SecretStorageUnavailableError();
    return material;
  }

  private async load(reference: string): Promise<CipherRow | null> {
    const row = await this.env.DB.prepare(
      `SELECT * FROM secret_ciphertexts WHERE id = ?`,
    )
      .bind(reference)
      .first();
    return row ? (row as unknown as CipherRow) : null;
  }

  private assertSameCompany(recordCompanyId: string, requested: string): void {
    if (recordCompanyId !== requested) {
      throw new SecretTenantMismatchError();
    }
  }

  private isWorkerBindingRef(reference: string): boolean {
    return (
      reference.startsWith("binding:") || /^[A-Z][A-Z0-9_]+$/.test(reference)
    );
  }

  /**
   * MCP Worker secrets stay as env bindings. Resolve only when the named
   * binding belongs to this company's MCP row.
   */
  private async resolveWorkerBinding(
    reference: string,
    context: SecretAccessContext,
  ): Promise<string | null> {
    const name = reference.startsWith("binding:")
      ? reference.slice("binding:".length)
      : reference;
    const owned = await this.env.DB.prepare(
      `SELECT id FROM mcp_environments
       WHERE company_id = ? AND auth_secret_ref = ?`,
    )
      .bind(context.companyId, name)
      .first();
    if (!owned) return null;
    const value = (this.env as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
  }
}
