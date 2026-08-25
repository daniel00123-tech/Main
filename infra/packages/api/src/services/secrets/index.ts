import type { Env } from "../../env";
import { DisabledProductionSecretProvider } from "./disabled";
import { MemorySecretProvider } from "./memory";
import type { SecretProvider } from "./provider";

export * from "./provider";
export { MemorySecretProvider } from "./memory";
export { DisabledProductionSecretProvider } from "./disabled";

const testProviders = new WeakMap<object, SecretProvider>();

/** Tests inject a memory provider. Production uses the disabled store. */
export function createSecretProvider(env: Env): SecretProvider {
  const injected = testProviders.get(env as object);
  if (injected) return injected;
  if (env.ENVIRONMENT === "test") {
    return new MemorySecretProvider();
  }
  return new DisabledProductionSecretProvider(env);
}

export function installTestSecretProvider(
  env: Env,
  provider: SecretProvider,
): void {
  testProviders.set(env as object, provider);
}
