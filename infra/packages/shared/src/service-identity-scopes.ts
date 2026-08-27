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

/** Action Engine control scopes for ChatGPT planning/confirmation (not direct Xero writes). */
export const XERO_ACTION_SERVICE_SCOPES = [
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.execute",
  "xero.action.cancel",
  "xero.action.list",
] as const;

export function mergeServiceIdentityScopes(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function serviceIdentityScopesWithXeroRead(
  base: readonly string[] = BASE_AI_SERVICE_SCOPES,
): string[] {
  return mergeServiceIdentityScopes([...base], XERO_READ_SERVICE_SCOPES);
}

export function serviceIdentityScopesWithXeroActionEngine(
  base: readonly string[] = BASE_AI_SERVICE_SCOPES,
): string[] {
  return mergeServiceIdentityScopes(
    serviceIdentityScopesWithXeroRead(base),
    [...XERO_ACTION_SERVICE_SCOPES],
  );
}

/** Scopes for a company with connected Xero; action engine when write OAuth is consented. */
export function serviceIdentityScopesForConnectedXero(input: {
  writeOAuthConsented: boolean;
  base?: readonly string[];
}): string[] {
  if (!input.writeOAuthConsented) {
    return serviceIdentityScopesWithXeroRead(input.base);
  }
  return serviceIdentityScopesWithXeroActionEngine(input.base);
}
