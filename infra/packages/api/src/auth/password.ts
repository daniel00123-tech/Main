const PBKDF2_ITERATIONS = 100_000;
const HASH_LENGTH = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    HASH_LENGTH * 8,
  );

  return new Uint8Array(derived);
}

export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return toBase64(salt);
}

export async function hashPassword(
  password: string,
  saltBase64: string,
): Promise<string> {
  const salt = fromBase64(saltBase64);
  const hash = await deriveKey(password, salt);
  return toBase64(hash);
}

export async function verifyPassword(
  password: string,
  saltBase64: string,
  expectedHashBase64: string,
): Promise<boolean> {
  const actualHash = await hashPassword(password, saltBase64);
  if (actualHash.length !== expectedHashBase64.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < actualHash.length; i += 1) {
    mismatch |= actualHash.charCodeAt(i) ^ expectedHashBase64.charCodeAt(i);
  }
  return mismatch === 0;
}
