import type { ElXeroConfig } from "./config";

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

async function wrappingKey(config: ElXeroConfig): Promise<CryptoKey> {
  const material = await sha256Bytes(`el-business-mcp|xero|${config.clientId}|${config.clientSecret}`);
  return crypto.subtle.importKey("raw", material.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(config: ElXeroConfig, payload: unknown): Promise<{ nonce: string; ciphertext: string }> {
  const key = await wrappingKey(config);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
    key,
    encoded
  );
  return { nonce: bytesToB64(nonce), ciphertext: bytesToB64(new Uint8Array(encrypted)) };
}

export async function decryptJson<T>(config: ElXeroConfig, nonce: string, ciphertext: string): Promise<T> {
  const key = await wrappingKey(config);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(nonce).buffer as ArrayBuffer },
    key,
    b64ToBytes(ciphertext).buffer as ArrayBuffer
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export function randomUrlToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}
