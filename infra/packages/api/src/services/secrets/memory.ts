import {
  SecretTenantMismatchError,
  type SecretAccessContext,
  type SecretProvider,
  type SecretStoreInput,
  type StoredSecretRef,
} from "./provider";

type MemoryRecord = StoredSecretRef & { value: string; revoked?: boolean };

/**
 * In-memory provider for automated tests. Production never uses this.
 */
export class MemorySecretProvider implements SecretProvider {
  readonly kind = "memory";
  readonly submissionEnabled = true;
  private readonly records = new Map<string, MemoryRecord>();

  async store(input: SecretStoreInput): Promise<StoredSecretRef> {
    const reference = `sec_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const record: MemoryRecord = {
      reference,
      companyId: input.companyId,
      purpose: input.purpose,
      connectorInstanceId: input.connectorInstanceId ?? null,
      createdAt,
      value: input.value,
    };
    this.records.set(reference, record);
    return this.publicRef(record);
  }

  async resolve(
    reference: string,
    context: SecretAccessContext,
  ): Promise<string | null> {
    const record = this.requireSameCompany(reference, context.companyId);
    if (!record || record.revoked) return null;
    return record.value;
  }

  async rotate(
    reference: string,
    value: string,
    context: SecretAccessContext,
  ): Promise<StoredSecretRef> {
    const existing = this.requireSameCompany(reference, context.companyId);
    if (!existing) {
      throw new SecretTenantMismatchError();
    }
    existing.value = value;
    existing.rotatedAt = new Date().toISOString();
    existing.revoked = false;
    return this.publicRef(existing);
  }

  async revoke(reference: string, context: SecretAccessContext): Promise<void> {
    const existing = this.requireSameCompany(reference, context.companyId);
    if (!existing) throw new SecretTenantMismatchError();
    existing.revoked = true;
    existing.value = "";
  }

  async exists(
    reference: string,
    context: SecretAccessContext,
  ): Promise<boolean> {
    const record = this.requireSameCompany(reference, context.companyId);
    return Boolean(record && !record.revoked);
  }

  /** Test helper — never expose in production routes. */
  peek(reference: string): string | undefined {
    return this.records.get(reference)?.value;
  }

  private requireSameCompany(
    reference: string,
    companyId: string,
  ): MemoryRecord | null {
    const record = this.records.get(reference);
    if (!record) return null;
    if (record.companyId !== companyId) {
      throw new SecretTenantMismatchError();
    }
    return record;
  }

  private publicRef(record: MemoryRecord): StoredSecretRef {
    return {
      reference: record.reference,
      companyId: record.companyId,
      purpose: record.purpose,
      connectorInstanceId: record.connectorInstanceId,
      createdAt: record.createdAt,
      rotatedAt: record.rotatedAt ?? null,
    };
  }
}
