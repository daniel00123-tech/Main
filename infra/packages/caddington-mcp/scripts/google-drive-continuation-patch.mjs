/** Patches caddington-mcp base worker for resumable ENTIRE_DRIVE scan auto-continuation. */

export function applyGoogleDriveContinuationPatches(base) {
  const marker = "google_drive_auto_continuation";
  if (base.includes(marker)) return base;

  const helpersTarget = `async function scanAndQueueGoogleDriveChanges(env22, options = {}) {`;
  const helpersReplacement = `async function enqueueGoogleDriveScanBatch(env22, body) {
  if (!env22.GOOGLE_DRIVE_SYNC_QUEUE) return false;
  await env22.GOOGLE_DRIVE_SYNC_QUEUE.send({
    kind: "scan_batch",
    trigger: body.trigger ?? "manual",
    dryRun: body.dryRun ?? false,
    autoIndex: body.autoIndex !== false,
    batchId: body.batchId ?? null,
    maxFiles: body.maxFiles ?? null
  });
  return true;
}
__name(enqueueGoogleDriveScanBatch, "enqueueGoogleDriveScanBatch");
__name2(enqueueGoogleDriveScanBatch, "enqueueGoogleDriveScanBatch");
async function processGoogleDriveQueueMessage(env22, body) {
  if (body?.kind === "scan_batch") {
    return await scanAndQueueGoogleDriveChanges(env22, {
      trigger: body.trigger ?? "manual",
      dryRun: body.dryRun ?? false,
      autoIndex: body.autoIndex !== false,
      batchId: body.batchId ?? null,
      maxFiles: body.maxFiles ?? void 0
    });
  }
  return await processGoogleDriveFileMessage(env22, body);
}
__name(processGoogleDriveQueueMessage, "processGoogleDriveQueueMessage");
__name2(processGoogleDriveQueueMessage, "processGoogleDriveQueueMessage");
async function mergeGoogleDriveSyncJobMetadata(env22, batchId, patch) {
  const row = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT metadata FROM import_log WHERE id = ? LIMIT 1"
  ).bind(batchId).first();
  let existing = {};
  try {
    existing = row?.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    existing = {};
  }
  const totals = existing.totals ?? {};
  for (const key of ["listed", "allowed", "skipped", "queued", "unchanged"]) {
    totals[key] = Number(totals[key] ?? 0) + Number(patch[key] ?? 0);
  }
  const mergedSkip = { ...(totals.skipReasons ?? {}), ...(patch.skipReasons ?? {}) };
  for (const [reason, count] of Object.entries(patch.skipReasons ?? {})) {
    mergedSkip[reason] = Number(mergedSkip[reason] ?? 0) + Number(count);
  }
  totals.skipReasons = mergedSkip;
  const mergedQueue = { ...(totals.queueReasons ?? {}), ...(patch.queueReasons ?? {}) };
  for (const [reason, count] of Object.entries(patch.queueReasons ?? {})) {
    mergedQueue[reason] = Number(mergedQueue[reason] ?? 0) + Number(count);
  }
  totals.queueReasons = mergedQueue;
  const next = {
    ...existing,
    ...patch,
    totals,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    marker: "${marker}"
  };
  await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "UPDATE import_log SET metadata = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(JSON.stringify(next), batchId).run();
  return next;
}
__name(mergeGoogleDriveSyncJobMetadata, "mergeGoogleDriveSyncJobMetadata");
__name2(mergeGoogleDriveSyncJobMetadata, "mergeGoogleDriveSyncJobMetadata");
async function scanAndQueueGoogleDriveChanges(env22, options = {}) {`;

  if (!base.includes(helpersTarget)) {
    throw new Error("Unable to locate scanAndQueueGoogleDriveChanges for continuation helpers");
  }
  base = base.replace(helpersTarget, helpersReplacement);

  const batchInsertTarget = `  const importBatch = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    \`INSERT INTO import_log (source_system, import_type, status, metadata)
     VALUES (?, 'google_drive_sync', 'started', ?)\`
  ).bind(
    CONNECTOR_CODE2,
    JSON.stringify({
      dryRun,
      trigger,
      maxFiles: options.maxFiles ?? null,
      autoIndex,
      knowledgeFolderId: connectorConfig.knowledgeFolderId,
      knowledgeFolderName: connectorConfig.knowledgeFolderName,
      phase: "metadata_scan"
    })
  ).run();
  summary.batchId = Number(importBatch.meta.last_row_id);`;

  const batchInsertReplacement = `  if (options.batchId) {
    summary.batchId = Number(options.batchId);
    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "UPDATE import_log SET status = 'started', metadata = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(JSON.stringify({
      dryRun,
      trigger,
      maxFiles: options.maxFiles ?? null,
      autoIndex,
      scopeMode: connectorConfig.scopeMode,
      scanRootId: connectorConfig.scanRootId,
      knowledgeFolderId: connectorConfig.knowledgeFolderId,
      knowledgeFolderName: connectorConfig.knowledgeFolderName,
      phase: "metadata_scan",
      resumed: true,
      marker: "${marker}"
    }), summary.batchId).run();
  } else {
    const importBatch = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`INSERT INTO import_log (source_system, import_type, status, metadata)
       VALUES (?, 'google_drive_sync', 'started', ?)\`
    ).bind(
      CONNECTOR_CODE2,
      JSON.stringify({
        dryRun,
        trigger,
        maxFiles: options.maxFiles ?? null,
        autoIndex,
        scopeMode: connectorConfig.scopeMode,
        scanRootId: connectorConfig.scanRootId,
        knowledgeFolderId: connectorConfig.knowledgeFolderId,
        knowledgeFolderName: connectorConfig.knowledgeFolderName,
        phase: "metadata_scan",
        marker: "${marker}"
      })
    ).run();
    summary.batchId = Number(importBatch.meta.last_row_id);
  }`;

  if (base.includes(batchInsertTarget)) {
    base = base.replace(batchInsertTarget, batchInsertReplacement);
  } else {
    const altTarget = `      scopeMode: connectorConfig.scopeMode,
      scanRootId: connectorConfig.scanRootId,
      knowledgeFolderId: connectorConfig.knowledgeFolderId,
      knowledgeFolderName: connectorConfig.knowledgeFolderName,
      phase: "metadata_scan"
    })
  ).run();
  summary.batchId = Number(importBatch.meta.last_row_id);`;
    const altReplacement = `      scopeMode: connectorConfig.scopeMode,
      scanRootId: connectorConfig.scanRootId,
      knowledgeFolderId: connectorConfig.knowledgeFolderId,
      knowledgeFolderName: connectorConfig.knowledgeFolderName,
      phase: "metadata_scan",
      marker: "${marker}"
    })
  ).run();
  summary.batchId = Number(importBatch.meta.last_row_id);`;
    if (base.includes(altTarget)) {
      base = base.replace(
        /if \(options\.batchId\) \{[\s\S]*?summary\.batchId = Number\(importBatch\.meta\.last_row_id\);\s*\}/,
        batchInsertReplacement.trim(),
      );
    }
  }

  const completionTarget = `    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`UPDATE import_log
       SET status = 'completed', completed_at = datetime('now'),
           records_processed = ?, records_failed = ?, metadata = ?
       WHERE id = ?\`
    ).bind(summary.queued, summary.errors.length, JSON.stringify(summary), summary.batchId).run();
    log32("info", "google_drive_scan_completed", summary);
    return summary;`;

  const completionReplacement = `    summary.scanContinuation = typeof scanContinuation !== "undefined" ? scanContinuation : null;
    summary.scanComplete = !summary.scanContinuation;
    await mergeGoogleDriveSyncJobMetadata(env22, summary.batchId, summary);
    const jobStatus = summary.scanComplete ? "completed" : "in_progress";
    const jobMeta = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "SELECT metadata FROM import_log WHERE id = ? LIMIT 1"
    ).bind(summary.batchId).first();
    let jobMetadata = summary;
    try {
      jobMetadata = jobMeta?.metadata ? JSON.parse(jobMeta.metadata) : summary;
    } catch {
      jobMetadata = summary;
    }
    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`UPDATE import_log
       SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
           records_processed = ?, records_failed = ?, metadata = ?
       WHERE id = ?\`
    ).bind(
      jobStatus,
      jobStatus,
      summary.queued,
      summary.errors.length,
      JSON.stringify({ ...jobMetadata, lastBatch: summary }),
      summary.batchId
    ).run();
    if (summary.scanContinuation && !dryRun && env22.GOOGLE_DRIVE_SYNC_QUEUE) {
      const enqueued = await enqueueGoogleDriveScanBatch(env22, {
        trigger,
        dryRun,
        autoIndex,
        batchId: summary.batchId,
        maxFiles: options.maxFiles
      });
      if (!enqueued) {
        summary.errors.push("Scan continuation token remains but GOOGLE_DRIVE_SYNC_QUEUE is unavailable.");
      } else {
        log32("info", "google_drive_scan_continuation_enqueued", {
          batchId: summary.batchId,
          scanContinuation: summary.scanContinuation
        });
      }
    }
    log32("info", summary.scanComplete ? "google_drive_scan_completed" : "google_drive_scan_batch_completed", summary);
    return summary;`;

  if (!base.includes("google_drive_scan_batch_completed")) {
    if (!base.includes(completionTarget)) {
      throw new Error("Unable to locate google drive scan completion block");
    }
    base = base.replace(completionTarget, completionReplacement);
  }

  const fileMessageTarget = `      const message = {
        driveFileId: file2.id,
        name: file2.name,
        mimeType: file2.mimeType,
        modifiedTime: file2.modifiedTime ?? null,
        md5Checksum: file2.md5Checksum ?? null,
        trigger,
        autoIndex
      };`;
  const fileMessageReplacement = `      const message = {
        kind: "file",
        driveFileId: file2.id,
        name: file2.name,
        mimeType: file2.mimeType,
        modifiedTime: file2.modifiedTime ?? null,
        md5Checksum: file2.md5Checksum ?? null,
        trigger,
        autoIndex
      };`;
  if (base.includes(fileMessageTarget) && !base.includes('kind: "file"')) {
    base = base.replace(fileMessageTarget, fileMessageReplacement);
  }

  const syncStartTarget = `async function syncGoogleDriveDocuments(env22, options = {}) {
  const scan = await scanAndQueueGoogleDriveChanges(env22, options);`;
  const syncStartReplacement = `async function syncGoogleDriveDocuments(env22, options = {}) {
  const dryRun = options.dryRun ?? false;
  if (!dryRun && env22.GOOGLE_DRIVE_SYNC_QUEUE && options.useQueue !== false) {
    const connectorConfig = await loadGoogleDriveConnectorConfig(env22);
    const importBatch = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`INSERT INTO import_log (source_system, import_type, status, metadata)
       VALUES (?, 'google_drive_sync', 'started', ?)\`
    ).bind(
      CONNECTOR_CODE2,
      JSON.stringify({
        dryRun: false,
        trigger: options.trigger ?? "manual",
        autoIndex: options.autoIndex !== false,
        scopeMode: connectorConfig.scopeMode,
        scanRootId: connectorConfig.scanRootId,
        phase: "metadata_scan",
        mode: "queued_auto_continuation",
        marker: "${marker}"
      })
    ).run();
    const batchId = Number(importBatch.meta.last_row_id);
    const parsed = await loadConnectorConfigJson2(env22);
    const resetConfig = {
      ...parsed,
      scanState: { pageToken: null, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }
    };
    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`INSERT INTO connector_config (connector_code, config_json, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(connector_code) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at\`
    ).bind(CONNECTOR_CODE2, JSON.stringify(resetConfig)).run();
    await enqueueGoogleDriveScanBatch(env22, {
      trigger: options.trigger ?? "manual",
      dryRun: false,
      autoIndex: options.autoIndex !== false,
      batchId
    });
    return {
      dryRun: false,
      trigger: options.trigger ?? "manual",
      jobId: batchId,
      status: "started",
      mode: "queued_auto_continuation",
      message: "Google Drive sync job queued; scan batches will continue automatically until complete."
    };
  }
  const scan = await scanAndQueueGoogleDriveChanges(env22, options);`;

  if (!base.includes("queued_auto_continuation")) {
    if (!base.includes(syncStartTarget)) {
      throw new Error("Unable to locate syncGoogleDriveDocuments for queue start patch");
    }
    base = base.replace(syncStartTarget, syncStartReplacement);
  }

  const queueHandlerTarget = `  async queue(batch, env22) {
    for (const message of batch.messages) {
      try {
        await processGoogleDriveFileMessage(env22, message.body);
        message.ack();
      } catch (error53) {
        log32("error", "google_drive_queue_message_failed", {
          driveFileId: message.body.driveFileId,
          error: error53 instanceof Error ? error53.message : String(error53)
        });
        message.retry();
      }
    }
  }`;

  const queueHandlerReplacement = `  async queue(batch, env22) {
    for (const message of batch.messages) {
      try {
        await processGoogleDriveQueueMessage(env22, message.body);
        message.ack();
      } catch (error53) {
        log32("error", "google_drive_queue_message_failed", {
          kind: message.body?.kind ?? "file",
          driveFileId: message.body?.driveFileId,
          batchId: message.body?.batchId,
          error: error53 instanceof Error ? error53.message : String(error53)
        });
        message.retry();
      }
    }
  }`;

  if (!base.includes("processGoogleDriveQueueMessage(env22")) {
    if (!base.includes(queueHandlerTarget)) {
      throw new Error("Unable to locate google drive queue handler");
    }
    base = base.replace(queueHandlerTarget, queueHandlerReplacement);
  }

  const scheduledGateTarget = `async function shouldRunScheduledGoogleDriveScan(env22, scheduledTimeMs) {
  const schedule = await loadGoogleDriveScheduleConfig(env22);`;
  const scheduledGateReplacement = `async function shouldRunScheduledGoogleDriveScan(env22, scheduledTimeMs) {
  const parsed = await loadConnectorConfigJson(env22);
  const scanToken = parsed?.scanState?.pageToken;
  if (typeof scanToken === "string" && scanToken.trim()) {
    return {
      run: true,
      reason: "scan_continuation_pending",
      local: getLondonLocalTimeParts(new Date(scheduledTimeMs))
    };
  }
  const schedule = await loadGoogleDriveScheduleConfig(env22);`;

  if (!base.includes("scan_continuation_pending")) {
    if (!base.includes(scheduledGateTarget)) {
      throw new Error("Unable to locate shouldRunScheduledGoogleDriveScan");
    }
    base = base.replace(scheduledGateTarget, scheduledGateReplacement);
  }

  const scheduledCompleteTarget = `          const summary = await runScheduledGoogleDriveScan(env22);
          await recordScheduledGoogleDriveScanDate(env22, gate.local.calendarDate);`;
  const scheduledCompleteReplacement = `          const summary = await runScheduledGoogleDriveScan(env22);
          if (!summary?.scanContinuation) {
            await recordScheduledGoogleDriveScanDate(env22, gate.local.calendarDate);
          }`;

  if (!base.includes("summary?.scanContinuation")) {
    if (base.includes(scheduledCompleteTarget)) {
      base = base.replace(scheduledCompleteTarget, scheduledCompleteReplacement);
    }
  }

  return base;
}
