import type { Env } from "../../env";
import { wrappingKeyConfigured } from "./crypto";
import { DisabledProductionSecretProvider } from "./disabled";
import { EncryptedD1SecretProvider } from "./encrypted";
import { MemorySecretProvider } from "./memory";
import type { SecretProvider } from "./provider";

export * from "./provider";
export * from "./crypto";
export { MemorySecretProvider } from "./memory";
export { DisabledProductionSecretProvider } from "./disabled";
export { EncryptedD1SecretProvider } from "./encrypted";

const testProviders = new WeakMap<object, SecretProvider>();

/** Tests inject a provider. Production uses envelope encryption when the wrapping key is set. */
export function createSecretProvider(env: Env): SecretProvider {
  const injected = testProviders.get(env as object);
  if (injected) return injected;
  if (wrappingKeyConfigured(env as Record<string, unknown>)) {
    return new EncryptedD1SecretProvider(env);
  }
  if (env.ENVIRONMENT === "test") {
    return new MemorySecretProvider();
  }
  return new DisabledProductionSecretProvider(env);
}

export function credentialStorageStatus(env: Env): {
  enabled: boolean;
  reason: string;
} {
  const injected = testProviders.get(env as object);
  if (injected) {
    return {
      enabled: injected.submissionEnabled,
      reason: injected.submissionEnabled
        ? "Secure credential storage is available"
        : "Secure credential storage is not configured",
    };
  }
  if (wrappingKeyConfigured(env as Record<string, unknown>)) {
    return {
      enabled: true,
      reason: "Secure credential storage is available",
    };
  }
  return {
    enabled: false,
    reason: "Secure credential storage is not configured.",
  };
}

export function installTestSecretProvider(
  env: Env,
  provider: SecretProvider,
): void {
  testProviders.set(env as object, provider);
}
