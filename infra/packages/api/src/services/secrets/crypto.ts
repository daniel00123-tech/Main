/**
 * Authenticated envelope encryption for connector credentials.
 * AES-256-GCM via Web Crypto. One random 96-bit nonce per encrypt.
 */

export const CREDENTIAL_ALGORITHM = "AES-256-GCM";
export const DEFAULT_KEY_VERSION = "v1";
export const WRAPPING_KEY_ENV = "INFRA_CREDENTIAL_WRAPPING_KEY";
export const KEY_VERSION_ENV = "INFRA_CREDENTIAL_KEY_VERSION";
export const MAX_CREDENTIAL_BYTES = 32 * 1024;

export class SecretCryptoError extends Error {
  readonly code = "CREDENTIAL_CRYPTO_FAILED";
  constructor(message = "Credential cryptographic operation failed") {
    super(message);
    this.name = "SecretCryptoError";
  }
}

export class SecretStorageUnavailableError extends Error {
  readonly code = "CREDENTIAL_SUBMISSION_DISABLED";
  constructor(message = "Secure credential storage is not configured") {
    super(message);
    this.name = "SecretStorageUnavailableError";
  }
}

export function currentKeyVersion(env: Record<string, unknown>): string {
  const raw = env[KEY_VERSION_ENV];
  if (typeof raw === "string" && /^v[0-9]+$/i.test(raw.trim())) {
    return raw.trim().toLowerCase();
  }
  return DEFAULT_KEY_VERSION;
}

export function wrappingKeyEnvName(version: string): string {
  return `INFRA_CREDENTIAL_WRAPPING_KEY_${version.trim().toLowerCase().toUpperCase()}`;
}

export function readWrappingKeyMaterial(
  env: Record<string, unknown>,
  version: string,
): string | null {
  const current = currentKeyVersion(env);
  const names: string[] = [];
  if (version === current) names.push(WRAPPING_KEY_ENV);
  names.push(wrappingKeyEnvName(version));
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function wrappingKeyConfigured(env: Record<string, unknown>): boolean {
  return Boolean(readWrappingKeyMaterial(env, currentKeyVersion(env)));
}

export function parseWrappingKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  try {
    const binary = atob(trimmed);
    if (binary.length === 32) {
      return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    }
  } catch {
    // fall through
  }
  throw new SecretCryptoError();
}

async function importAesKey(raw: Uint8Array, usage: Array<"encrypt" | "decrypt">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usage);
}

export function buildAad(input: {
  keyVersion: string;
  companyId: string;
  purpose: string;
  connectorInstanceId?: string | null;
  reference: string;
}): string {
  return [
    CREDENTIAL_ALGORITHM,
    input.keyVersion,
    input.companyId,
    input.purpose,
    input.connectorInstanceId ?? "",
    input.reference,
  ].join("|");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    throw new SecretCryptoError();
  }
}

export async function encryptCredential(input: {
  plaintext: string;
  keyMaterial: string;
  aad: string;
}): Promise<{ nonceB64: string; ciphertextB64: string }> {
  const encoded = new TextEncoder().encode(input.plaintext);
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_CREDENTIAL_BYTES) {
    throw new SecretCryptoError();
  }
  const key = await importAesKey(parseWrappingKey(input.keyMaterial), ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(input.aad),
        tagLength: 128,
      },
      key,
      encoded,
    ),
  );
  return {
    nonceB64: bytesToBase64(nonce),
    ciphertextB64: bytesToBase64(ciphertext),
  };
}

export async function decryptCredential(input: {
  nonceB64: string;
  ciphertextB64: string;
  keyMaterial: string;
  aad: string;
}): Promise<string> {
  try {
    const key = await importAesKey(parseWrappingKey(input.keyMaterial), ["decrypt"]);
    const nonce = base64ToBytes(input.nonceB64);
    const ciphertext = base64ToBytes(input.ciphertextB64);
    if (nonce.byteLength !== 12 || ciphertext.byteLength < 16) {
      throw new SecretCryptoError();
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(input.aad),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError();
  }
}
