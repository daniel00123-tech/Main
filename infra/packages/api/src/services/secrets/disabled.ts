import type { Env } from "../../env";
import {
  CredentialSubmissionDisabledError,
  SecretTenantMismatchError,
  type SecretAccessContext,
  type SecretProvider,
  type SecretStoreInput,
  type StoredSecretRef,
} from "./provider";

/**
 * Production provider until a scalable vault is approved.
 *
 * - store / rotate refuse plaintext so secrets never land in D1.
 * - resolve only reads existing Worker secret *bindings* by name.
 * - Binding names must already be associated with the company MCP row.
 */
export class DisabledProductionSecretProvider implements SecretProvider {
  readonly kind = "disabled_production";
  readonly submissionEnabled = false;

  constructor(private readonly env: Env) {}

  async store(_input: SecretStoreInput): Promise<StoredSecretRef> {
    throw new CredentialSubmissionDisabledError();
  }

  async resolve(
    reference: string,
    context: SecretAccessContext,
  ): Promise<string | null> {
    if (reference.startsWith("binding:")) {
      const name = reference.slice("binding:".length);
      return this.readBinding(name);
    }
    if (/^[A-Z][A-Z0-9_]+$/.test(reference)) {
      return this.readBinding(reference);
    }
    if (context.reason === "existence_check") {
      return null;
    }
    return null;
  }

  async rotate(
    _reference: string,
    _value: string,
    _context: SecretAccessContext,
  ): Promise<StoredSecretRef> {
    throw new CredentialSubmissionDisabledError();
  }

  async revoke(
    _reference: string,
    _context: SecretAccessContext,
  ): Promise<void> {
    throw new CredentialSubmissionDisabledError(
      "Revocation of Worker secret bindings is a platform operation",
    );
  }

  async exists(
    reference: string,
    context: SecretAccessContext,
  ): Promise<boolean> {
    const value = await this.resolve(reference, {
      ...context,
      reason: "existence_check",
    });
    return Boolean(value);
  }

  private readBinding(name: string): string | null {
    const value = (this.env as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
  }
}

export function assertSameCompany(
  recordCompanyId: string,
  requestedCompanyId: string,
): void {
  if (recordCompanyId !== requestedCompanyId) {
    throw new SecretTenantMismatchError();
  }
}
