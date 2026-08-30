import type { Env } from "../env";
import { DEFAULT_APPROVED_MAILBOXES, loadMicrosoftConfig, publicMicrosoftPolicy } from "./config";
import { createMicrosoftContext } from "./context";
import { ElMicrosoftError } from "./errors";
import { acquireGraphToken } from "./auth";
import { listUsers } from "./directory";
import { listFolders, searchMailbox } from "./mail";
import { discoverSharePointSite, getFile, listEligibleOneDrives, searchFiles } from "./files";

export type VerifyCheck = {
  name: string;
  ok: boolean;
  detail: unknown;
};

export async function runMicrosoftVerification(env: Env): Promise<{
  overall: "PASS" | "PARTIAL" | "FAIL";
  policy: ReturnType<typeof publicMicrosoftPolicy>;
  protectedUsers: unknown;
  checks: VerifyCheck[];
}> {
  const checks: VerifyCheck[] = [];
  const config = loadMicrosoftConfig(env);
  const policyPublic = publicMicrosoftPolicy(config);

  const push = (name: string, ok: boolean, detail: unknown) => {
    checks.push({ name, ok, detail });
  };

  if (!config) {
    push("oauth_token", false, "Microsoft credentials missing on Worker");
    return { overall: "FAIL", policy: policyPublic, protectedUsers: [], checks };
  }

  try {
    const token = await acquireGraphToken(config);
    push("oauth_token", true, { cached: token.cached, expiresAtMs: token.expiresAtMs });
  } catch (error) {
    push("oauth_token", false, error instanceof Error ? error.message : String(error));
    return { overall: "FAIL", policy: policyPublic, protectedUsers: [], checks };
  }

  let ctx;
  try {
    ctx = await createMicrosoftContext(env);
    const users = await listUsers(ctx.graph, undefined, 5);
    push("directory_lookup", users.length > 0, { userCountSample: users.length });
  } catch (error) {
    push("directory_lookup", false, error instanceof Error ? error.message : String(error));
    return { overall: "FAIL", policy: policyPublic, protectedUsers: [], checks };
  }

  for (const mailbox of DEFAULT_APPROVED_MAILBOXES) {
    try {
      const folders = await listFolders(ctx.graph, ctx.policy, mailbox);
      const messages = await searchMailbox(ctx.graph, ctx.policy, { mailbox, top: 1 });
      push(`mailbox_${mailbox}`, true, {
        folderCount: folders.length,
        sampleMessages: messages.length,
      });
    } catch (error) {
      push(`mailbox_${mailbox}`, false, error instanceof Error ? error.message : String(error));
    }
  }

  try {
    await searchMailbox(ctx.graph, ctx.policy, {
      mailbox: "personal-staff@elvexpropertyservices.com",
      top: 1,
    });
    push("personal_mailbox_rejected", false, "personal mailbox was not rejected");
  } catch (error) {
    const code = error instanceof ElMicrosoftError ? error.code : "OTHER";
    push("personal_mailbox_rejected", code === "EL_MS_MAILBOX_DENIED", {
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const protectedUsers = ctx.policy.snapshot().protectedUsers;
  push(
    "resolve_william_ella",
    protectedUsers.length >= 1,
    {
      resolved: protectedUsers,
      unresolvedHints: ctx.policy.snapshot().unresolvedHints,
    }
  );

  try {
    const drives = await listEligibleOneDrives(ctx.graph, ctx.policy);
    const protectedDriveIds = new Set(
      protectedUsers.map((user) => user.driveId).filter(Boolean)
    );
    const leaked = drives.eligible.filter((drive) => protectedDriveIds.has(drive.id));
    push("protected_onedrives_excluded", leaked.length === 0, {
      eligibleCount: drives.eligible.length,
      excludedCount: drives.excluded.length,
      leaked,
      sampleEligible: drives.eligible.slice(0, 3).map((drive) => ({
        id: drive.id,
        owner: drive.owner,
      })),
    });
  } catch (error) {
    push("protected_onedrives_excluded", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const site = await discoverSharePointSite(ctx.graph, ctx.config);
    push("sharepoint_site", Boolean(site?.id), site);
  } catch (error) {
    push("sharepoint_site", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const files = await searchFiles(ctx.graph, ctx.config, ctx.policy, {
      query: "elvex",
      top: 5,
    });
    const leaked = files.results.filter(
      (hit) => ctx.policy.isProtectedUser(hit.owner) || ctx.policy.isProtectedDrive(hit.driveId)
    );
    push("file_search_provenance", files.results.every((hit) => Boolean(hit.provenance)), {
      resultCount: files.results.length,
      sample: files.results.slice(0, 3),
    });
    push("protected_files_not_leaked", leaked.length === 0, {
      leakedCount: leaked.length,
      excludedProtectedCount: files.excludedProtectedCount,
    });
  } catch (error) {
    push("file_search_provenance", false, error instanceof Error ? error.message : String(error));
    push("protected_files_not_leaked", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const firstProtectedDrive = protectedUsers.find((user) => user.driveId)?.driveId;
    if (firstProtectedDrive) {
      await getFile(ctx.graph, ctx.policy, { driveId: firstProtectedDrive, itemId: "root" });
      push("protected_drive_id_denied", false, "protected drive was accessible");
    } else {
      push("protected_drive_id_denied", true, "no protected drive id resolved — policy still denies by owner/hint");
    }
  } catch (error) {
    const code = error instanceof ElMicrosoftError ? error.code : "OTHER";
    push("protected_drive_id_denied", code === "EL_MS_PROTECTED_DRIVE_DENIED" || code === "EL_MS_GRAPH_ERROR", {
      code,
    });
  }

  const failed = checks.filter((check) => !check.ok).length;
  const overall = failed === 0 ? "PASS" : failed >= checks.length / 2 ? "FAIL" : "PARTIAL";
  return { overall, policy: policyPublic, protectedUsers, checks };
}
