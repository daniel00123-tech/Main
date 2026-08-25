import type {
  ConnectorAuthMethod,
  ConnectorCapability,
  ConnectorDefinition,
  ConnectorOauthContract,
} from "../types";
import { taxonomyForConnector } from "./taxonomy";

const DEFAULT_OAUTH: ConnectorOauthContract = {
  authorizationUrl: null,
  tokenUrl: null,
  pkceRequired: true,
  requiredScopes: [],
  optionalScopes: [],
  callbackPath: "/api/connectors/oauth/callback",
};

export function defaultOauthContract(
  method?: ConnectorAuthMethod,
): ConnectorOauthContract | undefined {
  if (method !== "oauth") return undefined;
  return { ...DEFAULT_OAUTH };
}

/** Catalogue definition presented to APIs — never includes secret values. */
export function publicConnectorDefinition(
  connector: ConnectorDefinition,
): ConnectorDefinition {
  return {
    ...connector,
    taxonomyCategory: taxonomyForConnector(connector),
    brandKey: connector.brandKey ?? connector.slug,
    oauth: connector.oauth ?? defaultOauthContract(connector.authenticationMethod),
    minMcpVersion: connector.minMcpVersion ?? null,
    minCoreVersion: connector.minCoreVersion ?? null,
    documentationUrl: connector.documentationUrl ?? null,
  };
}

export function capabilityGroups(capabilities: ConnectorCapability[]): {
  read: boolean;
  write: boolean;
  sync: boolean;
  webhook: boolean;
  financial: boolean;
} {
  return {
    read: capabilities.some((item) =>
      ["read", "search", "analyse", "index", "export", "live_query"].includes(item),
    ),
    write: capabilities.some((item) =>
      ["create", "update", "delete", "batch", "send"].includes(item),
    ),
    sync: capabilities.includes("sync"),
    webhook: capabilities.includes("webhook"),
    financial: false,
  };
}
