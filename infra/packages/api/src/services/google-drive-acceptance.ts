import type { Env } from "../env";

function mcpAdminAuth(env: Env): string | null {
  const token =
    typeof env.CADDINGTON_ADMIN_TOKEN === "string" ? env.CADDINGTON_ADMIN_TOKEN.trim() : "";
  return token ? `Bearer ${token}` : null;
}

async function mcpAdminFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const auth = mcpAdminAuth(env);
  if (!auth) {
    return { status: 503, body: { error: "CADDINGTON_ADMIN_TOKEN not configured" } };
  }
  const binding = env.CADDINGTON_MCP;
  if (!binding) {
    return { status: 503, body: { error: "CADDINGTON_MCP service binding unavailable" } };
  }
  const res = await binding.fetch(
    new Request(`https://company-mcp.internal${path}`, {
      ...init,
      headers: {
        Authorization: auth,
        ...(init.headers ?? {}),
      },
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export async function runGoogleDriveWholeDriveAcceptance(env: Env) {
  const status = await mcpAdminFetch(env, "/admin/connectors/google_drive");
  const preview = await mcpAdminFetch(env, "/admin/connectors/google_drive/preview");
  const dryRun = await mcpAdminFetch(env, "/admin/connectors/google_drive/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun: true, autoIndex: false }),
  });
  const idempotencyDryRun = await mcpAdminFetch(env, "/admin/connectors/google_drive/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun: true, autoIndex: false }),
  });

  const skipReasons = (dryRun.body?.skipReasons ?? {}) as Record<string, number>;
  const imageSkipped =
    (skipReasons.excluded_mime_prefix ?? 0) +
    (skipReasons.excluded_extension ?? 0) +
    (skipReasons.excluded_mime ?? 0);

  const scopeMode = status.body?.scopeMode;
  const scanRootId = status.body?.scanRootId;
  const listed = Number(dryRun.body?.listed ?? 0);
  const allowed = Number(dryRun.body?.allowed ?? 0);
  const queuedFirst = Number(dryRun.body?.queued ?? 0);
  const queuedSecond = Number(idempotencyDryRun.body?.queued ?? 0);

  const classification =
    status.status === 200 &&
    scopeMode === "ENTIRE_DRIVE" &&
    scanRootId === "root" &&
    allowed > 0 &&
    queuedFirst === queuedSecond
      ? "PASS"
      : status.status === 200 && scopeMode === "ENTIRE_DRIVE"
        ? "PARTIAL"
        : "FAIL";

  const continuation = {
    architecture: "queued_auto_continuation",
    queueBinding: "GOOGLE_DRIVE_SYNC_QUEUE",
    checkpointField: "connector_config.config_json.scanState.pageToken",
    jobTable: "import_log",
    autoEnqueueOnPartialScan: true,
    manualResyncRequired: false,
  };

  return {
    classification,
    continuation,
    adminTokenConfigured: Boolean(mcpAdminAuth(env)),
    serviceBindingConfigured: Boolean(env.CADDINGTON_MCP),
    status: {
      httpStatus: status.status,
      scopeMode,
      scanRootId,
      imageIngestionPolicy: status.body?.imageIngestionPolicy,
      error: status.body?.error,
    },
    inventory: {
      listed,
      allowed,
      skipped: dryRun.body?.skipped,
      unchanged: dryRun.body?.unchanged,
      queuedDryRun: queuedFirst,
      skipReasons,
      imageExcludedCount: imageSkipped,
    },
    idempotency: {
      firstQueued: queuedFirst,
      secondQueued: queuedSecond,
      stable: queuedFirst === queuedSecond,
    },
    preview: {
      httpStatus: preview.status,
      recursiveFileCount: preview.body?.recursiveFileCount,
      recursiveAllowedCount: preview.body?.recursiveAllowedCount,
      recursiveSkippedCount: preview.body?.recursiveSkippedCount,
      error: preview.body?.error,
    },
    dryRun: {
      httpStatus: dryRun.status,
      error: dryRun.body?.error,
      errors: dryRun.body?.errors,
    },
    deploymentId: "7650276e-9da8-4ad1-af6b-bbbb54e385f4",
    notes:
      "Dry-run only. No file contents logged. Live sync/index requires separate operator approval.",
  };
}

/** Trigger one live Google Drive sync (production acceptance). */
export async function triggerGoogleDriveLiveSync(
  env: Env,
  input?: {
    dryRun?: boolean;
    autoIndex?: boolean;
    batchId?: number;
    useQueue?: boolean;
    trigger?: string;
  },
) {
  const sync = await mcpAdminFetch(env, "/admin/connectors/google_drive/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dryRun: input?.dryRun ?? false,
      autoIndex: input?.autoIndex ?? true,
      batchId: input?.batchId,
      useQueue: input?.useQueue,
      trigger: input?.trigger,
    }),
  });
  let ocrBackfill: unknown = null;
  try {
    const { runOcrBackfill } = await import("./ocr/backfill");
    ocrBackfill = await runOcrBackfill(env, { companyId: "co_caddington", limit: 2 });
  } catch {
    ocrBackfill = { skipped: true };
  }
  return {
    httpStatus: sync.status,
    ...sync.body,
    ocrBackfill,
  };
}
