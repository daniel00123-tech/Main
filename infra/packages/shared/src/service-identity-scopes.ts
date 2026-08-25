import { XERO_ACTIONS } from "./connectors/xero-actions";

/** Baseline scopes for ChatGPT / Claude service identities. */
export const BASE_AI_SERVICE_SCOPES = [
  "knowledge.search",
  "knowledge.read",
  "system.health",
] as const;

/** Read-only Xero actions exposed through INFRA when Xero OAuth is connected. */
export const XERO_READ_SERVICE_SCOPES = XERO_ACTIONS.filter(
  (action) => action.productionExecutable && !action.writesSupported,
).map((action) => action.action);

export function mergeServiceIdentityScopes(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function serviceIdentityScopesWithXeroRead(
  base: readonly string[] = BASE_AI_SERVICE_SCOPES,
): string[] {
  return mergeServiceIdentityScopes([...base], XERO_READ_SERVICE_SCOPES);
}
