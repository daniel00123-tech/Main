/**
 * CMD13D discovery phase — minimal Graph calls, no sync.
 */

import type { Env } from "../env";
import { acquireMicrosoftAppToken, microsoftCredentialStatus } from "./microsoft-auth";
import {
  classifyMicrosoftFile,
  getUserOneDrive,
  graphGetAll,
  listDriveChildren,
  listTenantUsers,
  type GraphDriveItem,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import { probeAdminKnowledgeBridge } from "./microsoft-acceptance";

const COMPANY_ID = "co_caddington";
const TEST_FOLDER = "INFRA Knowledge Test";

async function findFolderRecursive(
  config: MicrosoftGraphConfig,
  driveId: string,
  targetName: string,
  folderId?: string,
  pathPrefix = "",
  depth = 0,
): Promise<{ folder: GraphDriveItem; path: string } | null> {
  if (depth > 6) return null;
  const children = await listDriveChildren(config, driveId, folderId);
  for (const item of children) {
    const path = pathPrefix ? `${pathPrefix}/${item.name}` : item.name;
    if (item.folder && item.name.toLowerCase() === targetName.toLowerCase()) {
      return { folder: item, path };
    }
    if (item.folder) {
      const nested = await findFolderRecursive(config, driveId, targetName, item.id, path, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function resolveDanielUser(
  users: Array<{ id: string; userPrincipalName?: string | null; displayName?: string | null; mail?: string | null }>,
) {
  return (
    users.find((u) => (u.userPrincipalName ?? "").toLowerCase().includes("daniel")) ??
    users.find((u) => (u.displayName ?? "").toLowerCase().includes("daniel")) ??
    users.find((u) => (u.mail ?? "").toLowerCase().includes("daniel")) ??
    null
  );
}

export async function runCmd13dDiscovery(env: Env): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { phase: "discovery", ranAt: new Date().toISOString() };

  const adminBridge = await probeAdminKnowledgeBridge(env);
  report.adminBridge = adminBridge;

  const credentials = microsoftCredentialStatus(env);
  const graphToken = await acquireMicrosoftAppToken(env);
  report.microsoftGraphAuth = {
    ok: graphToken.ok,
    tenantIdMasked: credentials.tenantIdMasked,
    expectedPermissions: ["Files.Read.All", "Sites.Read.All", "User.Read.All"],
  };
  if (!graphToken.ok) return { ...report, verdict: "STOPPED_AT_GRAPH_AUTH" };

  const config: MicrosoftGraphConfig = { accessToken: graphToken.accessToken, tenantId: graphToken.tenantId };

  let users = await graphGetAll<{ id: string; userPrincipalName?: string; displayName?: string; mail?: string }>(
    config,
    `/users?$filter=startswith(displayName,'Daniel')&$select=id,userPrincipalName,displayName,mail&$top=10`,
    1,
  );
  if (users.length === 0) {
    users = await listTenantUsers(config).then((all) => all.slice(0, 20));
  }

  report.userDiscovery = { usersFound: users.length };
  const danielUser = resolveDanielUser(users);
  report.danielUser = danielUser
    ? { found: true, displayName: danielUser.displayName, id: danielUser.id }
    : { found: false };

  if (!danielUser?.id) return { ...report, verdict: "STOPPED_NO_DANIEL_USER" };

  const danielDrive = await getUserOneDrive(config, danielUser.id);
  if (!danielDrive) return { ...report, verdict: "STOPPED_NO_ONEDRIVE" };

  const testFolder = await findFolderRecursive(config, danielDrive.id, TEST_FOLDER);
  const testFiles = testFolder
    ? (await listDriveChildren(config, danielDrive.id, testFolder.folder.id))
        .filter((i) => i.file)
        .map((item) => ({
          name: item.name,
          path: `${testFolder.path}/${item.name}`,
          mimeType: item.file?.mimeType ?? item.mimeType ?? null,
          size: item.size ?? null,
          modifiedAt: item.lastModifiedDateTime,
          classification: classifyMicrosoftFile(
            item.file?.mimeType ?? item.mimeType ?? null,
            item.name,
          ).indexingStatus,
        }))
    : [];

  report.danielOneDrive = {
    driveId: danielDrive.id,
    driveType: danielDrive.driveType,
    ownerDisplayName: danielUser.displayName,
    testFolderFound: Boolean(testFolder),
    testFolderPath: testFolder?.path ?? null,
    testFiles,
  };

  return {
    ...report,
    verdict: testFolder ? "DISCOVERY_COMPLETE" : "STOPPED_NO_TEST_FOLDER",
    companyId: COMPANY_ID,
    driveId: danielDrive.id,
    danielUserId: danielUser.id,
  };
}
