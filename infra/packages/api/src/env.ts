export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  SESSION_SECRET: string;
  ALLOWED_ORIGINS: string;
  COOKIE_CROSS_ORIGIN?: string;
  INITIAL_PLATFORM_ADMIN_EMAIL?: string;
  INITIAL_PLATFORM_ADMIN_PASSWORD?: string;
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
