/**
 * Per-company Xero write mode resolution (additive kill-switch).
 */

import type { XeroCompanyWriteMode } from "@infra/shared";
import { getConnectorInstance, listConnectorInstances } from "./control-plane";

const CADDINGTON_REFERENCE_TENANT = "co_caddington";

export function defaultXeroWriteModeForCompany(companyId: string): XeroCompanyWriteMode {
  if (companyId === CADDINGTON_REFERENCE_TENANT) {
    return "CONTROLLED_WRITE";
  }
  return "READ_ONLY";
}

export function parseXeroWriteModeFromConfig(
  config: Record<string, unknown> | null | undefined,
): XeroCompanyWriteMode | null {
  const raw = config?.xeroWriteMode ?? config?.xero_write_mode;
  if (raw === "READ_ONLY" || raw === "CONTROLLED_WRITE" || raw === "FULL_APPROVED_WRITE") {
    return raw;
  }
  return null;
}

export async function resolveCompanyXeroWriteMode(
  db: D1Database,
  companyId: string,
  connectorInstanceId?: string | null,
): Promise<{ mode: XeroCompanyWriteMode; instanceId: string | null }> {
  let instance =
    connectorInstanceId != null
      ? await getConnectorInstance(db, connectorInstanceId)
      : null;

  if (!instance) {
    const instances = await listConnectorInstances(db, companyId);
    instance =
      instances.find(
        (row) =>
          row.connectorDefinitionId === "conn_xero" &&
          row.authStatus === "connected" &&
          Boolean(row.externalAccountId),
      ) ?? instances.find((row) => row.connectorDefinitionId === "conn_xero") ?? null;
  }

  if (!instance || instance.companyId !== companyId) {
    return { mode: defaultXeroWriteModeForCompany(companyId), instanceId: null };
  }

  const configured = parseXeroWriteModeFromConfig(instance.config ?? {});
  return {
    mode: configured ?? defaultXeroWriteModeForCompany(companyId),
    instanceId: instance.id,
  };
}
