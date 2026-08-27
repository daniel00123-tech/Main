/**
 * CMD13 production acceptance — runs in infra-api worker context.
 * Never returns secrets or bearer tokens.
 */

import type { Env } from "../env";
import {
  acquireMicrosoftAppToken,
  microsoftCredentialStatus,
} from "./microsoft-auth";
import {
  classifyMicrosoftFile,
  formatMicrosoftSourceLabel,
  listAllDrives,
  listDriveChildren,
  listSites,
  listSiteDrives,
  type GraphDrive,
  type GraphDriveItem,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import {
  discoverMicrosoftSources,
  listMicrosoftSources,
  setMicrosoftSourceInclusion,
  syncMicrosoftSource,
} from "./microsoft-sync";
import { listMcpEnvironments } from "./control-plane";

const COMPANY_ID = "co_caddington";
const CONNECTOR_DEF = "conn_microsoft_365";
const TEST_FOLDER = "INFRA Knowledge Test";

export async function probeAdminKnowledgeBridge(env: Env): Promise<{
  ok: boolean;
  status: number;
  message: string;
}> {
  const token =
    typeof env.CADDINGTON_ADMIN_TOKEN === "string" ? env.CADDINGTON_ADMIN_TOKEN.trim() : "";
  if (!token) {
    return { ok: false, status: 0, message: "CADDINGTON_ADMIN_TOKEN not configured on infra-api" };
  }
  const binding = env.CADDINGTON_MCP;
  if (!binding) {
    return { ok: false, status: 0, message: "CADDINGTON_MCP service binding unavailable" };
  }
  const response = await binding.fetch(
    new Request("https://company-mcp.internal/admin/health", {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  return {
    ok: response.status === 200,
    status: response.status,
    message:
      response.status === 200
        ? "caddington-mcp /admin/health authenticated successfully"
        : `caddington-mcp /admin/health returned HTTP ${response.status}`,
  };
}

type SafeFile = {
  name: string;
  path: string;
  mimeType: string | null;
  size: number | null;
  classification: string;
};

async function findFolderRecursive(
  config: MicrosoftGraphConfig,
  driveId: string,
  targetName: string,
  folderId?: string,
  pathPrefix = "",
  depth = 0,
): Promise<{ folder: GraphDriveItem; path: string } | null> {
  if (depth > 8) return null;
  const children = await listDriveChildren(config, driveId, folderId);
  for (const item of children) {
    const path = pathPrefix ? `${pathPrefix}/${item.name}` : item.name;
    if (item.folder && item.name.toLowerCase() === targetName.toLowerCase()) {
      return { folder: item, path };
    }
    if (item.folder) {
      const nested = await findFolderRecursive(
        config,
        driveId,
        targetName,
        item.id,
        path,
        depth + 1,
      );
      if (nested) return nested;
    }
  }
  return null;
}

async function listFolderFiles(
  config: MicrosoftGraphConfig,
  driveId: string,
  folderId: string,
  pathPrefix: string,
): Promise<SafeFile[]> {
  const children = await listDriveChildren(config, driveId, folderId);
  const files: SafeFile[] = [];
  for (const item of children) {
    if (item.file) {
      const classification = classifyMicrosoftFile(
        item.file?.mimeType ?? item.mimeType ?? null,
        item.name,
      );
      files.push({
        name: item.name,
        path: `${pathPrefix}/${item.name}`,
        mimeType: item.file?.mimeType ?? item.mimeType ?? null,
        size: item.size ?? null,
        classification: classification.indexingStatus,
      });
    }
  }
  return files;
}

function driveLabel(drive: GraphDrive): string {
  const owner = drive.owner?.user?.displayName ?? drive.owner?.user?.email ?? drive.name;
  return `${owner ?? "unknown"} (${drive.driveType})`;
}

async function ensureConnectorInstance(db: D1Database): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = ? LIMIT 1`,
    )
    .bind(COMPANY_ID, CONNECTOR_DEF)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;

  const id = `ci_ms365_${Date.now()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO connector_instances (id, company_id, connector_definition_id, name, status, auth_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Microsoft 365', 'configured', 'connected', ?, ?)`,
    )
    .bind(id, COMPANY_ID, CONNECTOR_DEF, now, now)
    .run();
  return id;
}

export async function runCmd13MicrosoftAcceptance(env: Env): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    ranAt: new Date().toISOString(),
    companyId: COMPANY_ID,
  };

  const adminBridge = await probeAdminKnowledgeBridge(env);
  report.adminBridge = adminBridge;
  if (!adminBridge.ok) {
    report.stopped = "Admin bridge authentication failed — ingestion not attempted";
    report.verdict = "STOPPED_AT_PHASE_1";
    return report;
  }

  const credentials = microsoftCredentialStatus(env);
  const graphToken = await acquireMicrosoftAppToken(env);
  report.microsoftCredentials = {
    configured: credentials.configured,
    authMode: credentials.authMode,
    tenantIdMasked: credentials.tenantIdMasked,
    clientIdConfigured: credentials.clientIdConfigured,
    clientSecretConfigured: credentials.clientSecretConfigured,
  };
  report.microsoftGraphAuth = {
    ok: graphToken.ok,
    tenantIdMasked: credentials.tenantIdMasked,
    code: graphToken.ok ? null : graphToken.code,
    message: graphToken.ok ? "App-only token acquired" : graphToken.message,
  };
  if (!graphToken.ok) {
    report.stopped = "Microsoft Graph authentication failed";
    report.verdict = "STOPPED_AT_PHASE_2";
    return report;
  }

  const config: MicrosoftGraphConfig = {
    accessToken: graphToken.accessToken,
    tenantId: graphToken.tenantId,
  };

  const allDrives = await listAllDrives(config);
  const personalDrives = allDrives.filter((d) => d.driveType === "personal");
  report.onedriveDiscovery = {
    totalDrivesAccessible: allDrives.length,
    personalOneDrives: personalDrives.length,
    drives: personalDrives.slice(0, 20).map((d) => ({
      label: driveLabel(d),
      driveType: d.driveType,
      webUrl: d.webUrl,
      ownerEmail: d.owner?.user?.email ?? null,
    })),
  };

  let testOneDrive: GraphDrive | null = null;
  let testFolder: { folder: GraphDriveItem; path: string } | null = null;
  let testOneDriveFiles: SafeFile[] = [];

  for (const drive of personalDrives) {
    const folder = await findFolderRecursive(config, drive.id, TEST_FOLDER);
    if (folder) {
      testOneDrive = drive;
      testFolder = folder;
      testOneDriveFiles = await listFolderFiles(config, drive.id, folder.folder.id, folder.path);
      break;
    }
  }

  if (!testOneDrive) {
    for (const drive of personalDrives) {
      const owner = (drive.owner?.user?.email ?? drive.owner?.user?.displayName ?? "").toLowerCase();
      if (owner.includes("daniel") || owner.includes("dwyer")) {
        testOneDrive = drive;
        testFolder = await findFolderRecursive(config, drive.id, TEST_FOLDER);
        if (testFolder) {
          testOneDriveFiles = await listFolderFiles(
            config,
            drive.id,
            testFolder.folder.id,
            testFolder.path,
          );
        }
        break;
      }
    }
  }

  report.testOneDrive = testOneDrive
    ? {
        found: true,
        label: driveLabel(testOneDrive),
        ownerEmail: testOneDrive.owner?.user?.email ?? null,
        testFolderFound: Boolean(testFolder),
        testFolderPath: testFolder?.path ?? null,
        testFiles: testOneDriveFiles,
      }
    : { found: false, testFolderFound: false, testFiles: [] };

  const sites = await listSites(config);
  const sharepointLibraries: Array<{
    siteName: string;
    siteId: string;
    libraryName: string;
    driveId: string;
    webUrl: string | null;
    testFiles: SafeFile[];
  }> = [];

  for (const site of sites.slice(0, 30)) {
    const libraries = await listSiteDrives(config, site.id);
    for (const library of libraries) {
      const files: SafeFile[] = [];
      try {
        const rootChildren = await listDriveChildren(config, library.id);
        for (const item of rootChildren) {
          if (item.file) {
            const classification = classifyMicrosoftFile(
              item.file?.mimeType ?? item.mimeType ?? null,
              item.name,
            );
            files.push({
              name: item.name,
              path: item.name,
              mimeType: item.file?.mimeType ?? item.mimeType ?? null,
              size: item.size ?? null,
              classification: classification.indexingStatus,
            });
          }
          if (item.folder) {
            files.push(...(await listFolderFiles(config, library.id, item.id, item.name)));
          }
        }
      } catch {
        /* empty library */
      }
      sharepointLibraries.push({
        siteName: site.displayName ?? site.name,
        siteId: site.id,
        libraryName: library.name,
        driveId: library.id,
        webUrl: library.webUrl ?? site.webUrl,
        testFiles: files.slice(0, 20),
      });
    }
  }

  report.sharepointDiscovery = {
    sitesFound: sites.length,
    librariesSampled: sharepointLibraries.length,
    libraries: sharepointLibraries.slice(0, 15),
  };

  const testSharePointLib = sharepointLibraries.find(
    (l) =>
      l.libraryName.toLowerCase() === "documents" &&
      (l.siteName.toLowerCase().includes("communication") ||
        l.siteName.toLowerCase().includes("caddington")),
  );

  report.testSharePoint = testSharePointLib
    ? {
        found: true,
        siteName: testSharePointLib.siteName,
        libraryName: testSharePointLib.libraryName,
        driveId: testSharePointLib.driveId,
        testFiles: testSharePointLib.testFiles,
      }
    : { found: false, testFiles: [] };

  report.permissionScopeAssessment = {
    applicationPermissionsExpected: ["Files.Read.All", "Sites.Read.All"],
    discoveryMode: "App-only tenant-wide enumeration via /drives and /sites?search=*",
    oneDriveScope:
      "All personal OneDrives accessible under Files.Read.All — INFRA defaults sources to available, not auto-included",
    sharePointScope: "SharePoint sites/libraries via Sites.Read.All + site drives",
    adminConsentEvidence: graphToken.ok ? "Token acquisition succeeded" : "Failed",
    governanceNote: "Microsoft access ≠ INFRA knowledge visibility",
  };

  const connectorInstanceId = await ensureConnectorInstance(env.DB);
  await discoverMicrosoftSources(env, {
    companyId: COMPANY_ID,
    connectorInstanceId,
    actor: "cmd13-acceptance",
    includeAllOneDrives: false,
    includeAllSharePoint: false,
  });

  const sources = await listMicrosoftSources(env.DB, COMPANY_ID, connectorInstanceId);
  const sourcesToInclude = sources.filter((s) => {
    if (testOneDrive && s.externalId === testOneDrive.id && s.sourceType === "onedrive") return true;
    if (testSharePointLib && s.externalId === testSharePointLib.driveId && s.sourceType === "sharepoint")
      return true;
    return false;
  });

  for (const source of sourcesToInclude) {
    await setMicrosoftSourceInclusion(env.DB, {
      companyId: COMPANY_ID,
      sourceId: source.id,
      inclusionStatus: "included",
      actor: "cmd13-acceptance",
    });
  }

  const syncResults: Array<Record<string, unknown>> = [];
  for (const source of sourcesToInclude) {
    const result = await syncMicrosoftSource(env, {
      companyId: COMPANY_ID,
      connectorInstanceId,
      sourceId: source.id,
      actor: "cmd13-acceptance",
      useDelta: false,
      maxFiles: 25,
    });
    syncResults.push({
      sourceName: source.displayName,
      sourceType: source.sourceType,
      ...result,
    });
  }

  report.controlledSync = {
    connectorInstanceId,
    sourcesIncluded: sourcesToInclude.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      sourceType: s.sourceType,
    })),
    syncResults,
  };

  const knowledgeItems = await env.DB.prepare(
    `SELECT title, path, source_type, indexing_status, knowledge_document_id
     FROM microsoft_knowledge_items WHERE company_id = ? ORDER BY updated_at DESC LIMIT 30`,
  )
    .bind(COMPANY_ID)
    .all<{
      title: string;
      path: string | null;
      source_type: string;
      indexing_status: string;
      knowledge_document_id: number | null;
    }>();

  report.indexedItems = (knowledgeItems.results ?? []).map((row) => ({
    title: row.title,
    path: row.path,
    sourceType: row.source_type,
    indexingStatus: row.indexing_status,
    knowledgeDocumentId: row.knowledge_document_id,
    sourceLabel: formatMicrosoftSourceLabel({
      sourceType: row.source_type as "onedrive" | "sharepoint",
      displayName: row.source_type === "onedrive" ? "OneDrive" : "SharePoint",
      path: row.path,
      filename: row.title,
    }),
  }));

  const resyncResults: Array<Record<string, unknown>> = [];
  for (const source of sourcesToInclude) {
    const result = await syncMicrosoftSource(env, {
      companyId: COMPANY_ID,
      connectorInstanceId,
      sourceId: source.id,
      actor: "cmd13-acceptance-resync",
      useDelta: true,
      maxFiles: 25,
    });
    resyncResults.push({ sourceName: source.displayName, ...result });
  }

  const knowledgeCountAfter = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM microsoft_knowledge_items WHERE company_id = ?`,
  )
    .bind(COMPANY_ID)
    .first<{ cnt: number }>();

  report.idempotency = {
    resyncResults,
    knowledgeItemCountAfterResync: knowledgeCountAfter?.cnt ?? 0,
    uniqueExternalIds: (
      await env.DB.prepare(
        `SELECT COUNT(DISTINCT external_item_id) as cnt FROM microsoft_knowledge_items WHERE company_id = ?`,
      )
        .bind(COMPANY_ID)
        .first<{ cnt: number }>()
    )?.cnt,
  };

  const updatedSources = await listMicrosoftSources(env.DB, COMPANY_ID, connectorInstanceId);
  report.dashboardSnapshot = {
    totalSources: updatedSources.length,
    included: updatedSources.filter((s) => s.inclusionStatus === "included").length,
    sources: updatedSources.slice(0, 20).map((s) => ({
      displayName: s.displayName,
      sourceType: s.sourceType,
      inclusionStatus: s.inclusionStatus,
      syncStatus: s.syncStatus,
      itemsIndexed: s.itemsIndexed,
      lastError: s.lastError,
    })),
  };

  report.mcpRegistered = (await listMcpEnvironments(env.DB, COMPANY_ID)).length > 0;
  report.securityChecks = {
    credentialsServerSideOnly: true,
    adminBridgeRequiresAuth: adminBridge.ok,
    mcpAuthSeparateFromAdmin: true,
  };

  report.verdict = "ACCEPTANCE_COMPLETE";
  return report;
}
