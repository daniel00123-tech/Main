import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import { replayWhatsAppUat } from "./replay";
import { applyRuntimePatches, DEFAULT_QUALITY_RUNTIME } from "./runtime-config";
import { canAutoApply, classifyApplyClass, classifyApplyTier } from "./classify";
import { applyPolicyToPatches } from "./runtime-policy";
import {
  getActiveRuntimeRow,
  getProposal,
  insertHistory,
  insertRuntimeVersion,
  listHistoryForProposal,
  markRuntimeStatus,
  updateProposalStatus,
} from "./store";
import { CADDINGTON_COMPANY_ID, HIGH_RISK_PROPOSAL_KEYS, type QualityRuntimeConfig } from "./types";

export function resolveApplyBase(active: {
  canary?: { config: unknown } | null;
  promoted?: { config: unknown } | null;
}): QualityRuntimeConfig {
  const promoted = (active.promoted?.config as QualityRuntimeConfig | undefined) ?? undefined;
  const canary = (active.canary?.config as QualityRuntimeConfig | undefined) ?? undefined;
  return {
    ...DEFAULT_QUALITY_RUNTIME,
    ...(promoted ?? {}),
    ...(canary ?? {}),
    prompts: {
      ...DEFAULT_QUALITY_RUNTIME.prompts,
      ...(promoted?.prompts ?? {}),
      ...(canary?.prompts ?? {}),
    },
    planner: {
      ...DEFAULT_QUALITY_RUNTIME.planner,
      ...(promoted?.planner ?? {}),
      ...(canary?.planner ?? {}),
    },
    responseRules: {
      ...DEFAULT_QUALITY_RUNTIME.responseRules,
      ...(promoted?.responseRules ?? {}),
      ...(canary?.responseRules ?? {}),
    },
    thresholds: {
      ...DEFAULT_QUALITY_RUNTIME.thresholds,
      ...(promoted?.thresholds ?? {}),
      ...(canary?.thresholds ?? {}),
    },
    ranking: {
      ...DEFAULT_QUALITY_RUNTIME.ranking,
      ...(promoted?.ranking ?? {}),
      ...(canary?.ranking ?? {}),
    },
    suggestedActions: {
      ...DEFAULT_QUALITY_RUNTIME.suggestedActions,
      ...(promoted?.suggestedActions ?? {}),
      ...(canary?.suggestedActions ?? {}),
    },
    guidance: {
      ...DEFAULT_QUALITY_RUNTIME.guidance,
      ...(promoted?.guidance ?? {}),
      ...(canary?.guidance ?? {}),
    },
  };
}

export function isSafeAutoApplyPatch(patches: Array<{ path: string; value: unknown }>): boolean {
  return patches.every((patch) => {
    const path = patch.path.toLowerCase();
    if (HIGH_RISK_PROPOSAL_KEYS.some((key) => path.includes(key))) return false;
    if (path.includes("blockwriteintents") && patch.value === false) return false;
    return /^(prompts|planner|responserules|thresholds|ranking|suggestedactions|guidance)\./i.test(path.replace(/_/g, ""));
  });
}

export async function resolveActiveWhatsAppRuntime(
  env: Pick<Env, "DB">,
  input: { companyId?: string | null; userId?: string | null },
): Promise<QualityRuntimeConfig> {
  const { shouldUseCanaryRuntime } = await import("./runtime-config");
  const row = await getActiveRuntimeRow(env.DB);
  if (row.canary && shouldUseCanaryRuntime({
    companyId: input.companyId,
    userId: input.userId,
    canaryPercent: row.canary.canaryPercent,
    canaryCompanyId: row.canary.canaryCompanyId,
  })) {
    return { ...DEFAULT_QUALITY_RUNTIME, ...(row.canary.config as QualityRuntimeConfig), version: row.canary.version };
  }
  if (row.promoted) {
    return { ...DEFAULT_QUALITY_RUNTIME, ...(row.promoted.config as QualityRuntimeConfig), version: row.promoted.version };
  }
  return DEFAULT_QUALITY_RUNTIME;
}

export async function validateBeforePromote(runtime: QualityRuntimeConfig): Promise<{ ok: boolean; reason: string }> {
  const uat = replayWhatsAppUat(runtime);
  if (uat.failures > 0) {
    return { ok: false, reason: `${uat.failures} WhatsApp planner UAT failures` };
  }
  if (runtime.planner.blockWriteIntents === false) {
    return { ok: false, reason: "Refusing to disable write-intent blocking" };
  }
  return { ok: true, reason: "Validation passed" };
}

export async function previewProposal(env: Env, proposalId: string) {
  const proposal = await getProposal(env.DB, proposalId);
  if (!proposal) return { ok: false as const, reason: "Proposal not found" };
  const patch = proposal.patch as { patches?: Array<{ path: string; value: unknown }> };
  const rawPatches = patch?.patches ?? [];
  const patches = applyPolicyToPatches(rawPatches);
  const applyClass = classifyApplyClass({
    kind: proposal.kind,
    risk: proposal.risk,
    autoApplyable: proposal.autoApplyable,
    engineeringRequired: proposal.engineeringRequired,
    patchPaths: patches.map((item) => item.path),
  });
  const applyTier = classifyApplyTier({
    kind: proposal.kind,
    risk: proposal.risk,
    autoApplyable: proposal.autoApplyable,
    engineeringRequired: proposal.engineeringRequired,
    patchPaths: patches.map((item) => item.path),
  });
  const active = await getActiveRuntimeRow(env.DB);
  const base = resolveApplyBase(active);
  const next = applyClass === "AUTO_APPLY_SAFE" ? applyRuntimePatches(base, patches) : base;
  const validation = applyClass === "AUTO_APPLY_SAFE" ? await validateBeforePromote(next) : { ok: false, reason: "Not auto-applyable" };
  const history = await listHistoryForProposal(env.DB, proposal.id);
  return {
    ok: true as const,
    proposal,
    applyClass,
    applyTier,
    patches,
    before: base,
    after: next,
    validation,
    history,
    customerProgressUnchanged: true,
    executesChanges: false,
  };
}

export async function applyApprovedProposal(
  env: Env,
  input: { proposalId: string; actor: string; runId?: string | null },
): Promise<{ status: string; version?: number; reason: string }> {
  const proposal = await getProposal(env.DB, input.proposalId);
  if (!proposal) return { status: "missing", reason: "Proposal not found" };
  if (proposal.status === "canary" || proposal.status === "promoted") {
    return { status: proposal.status, reason: "Already applied (idempotent)" };
  }
  if (proposal.status !== "approved" && proposal.status !== "pending_approval" && proposal.status !== "applying") {
    return { status: proposal.status, reason: "Proposal is not awaiting apply" };
  }
  const patch = proposal.patch as { patches?: Array<{ path: string; value: unknown }> };
  const patchPaths = (patch?.patches ?? []).map((item) => item.path);
  const applyClass = classifyApplyClass({
    kind: proposal.kind,
    risk: proposal.risk,
    autoApplyable: proposal.autoApplyable,
    engineeringRequired: proposal.engineeringRequired,
    patchPaths,
  });
  if (
    applyClass !== "AUTO_APPLY_SAFE" ||
    !canAutoApply({
      kind: proposal.kind,
      risk: proposal.risk,
      autoApplyable: proposal.autoApplyable,
      engineeringRequired: proposal.engineeringRequired,
      status: proposal.status === "applying" ? "pending_approval" : proposal.status,
      patchPaths,
    })
  ) {
    await updateProposalStatus(env.DB, proposal.id, "approved");
    await insertHistory(env.DB, {
      proposalId: proposal.id,
      runId: input.runId ?? proposal.runId,
      action: "approved",
      actor: input.actor,
      evidence: { reportOnly: true, applyClass },
    });
    return { status: "approved", reason: "Recorded as report-only. ENGINEERING CHANGE REQUIRED — no production apply." };
  }
  const patches = applyPolicyToPatches(patch?.patches ?? []);
  if (!isSafeAutoApplyPatch(patches)) {
    await updateProposalStatus(env.DB, proposal.id, "failed_validation");
    await insertHistory(env.DB, {
      proposalId: proposal.id,
      runId: proposal.runId,
      action: "failed_validation",
      actor: input.actor,
      evidence: { reason: "Unsafe patch path" },
    });
    return { status: "failed_validation", reason: "Patch touched a forbidden path" };
  }

  await updateProposalStatus(env.DB, proposal.id, "applying");
  await insertHistory(env.DB, {
    proposalId: proposal.id,
    runId: input.runId ?? proposal.runId,
    action: "applying",
    actor: input.actor,
    evidence: { applyClass },
  });

  const active = await getActiveRuntimeRow(env.DB);
  const base = resolveApplyBase(active);
  const next = applyRuntimePatches(base, patches);
  const validation = await validateBeforePromote(next);
  if (!validation.ok) {
    await updateProposalStatus(env.DB, proposal.id, "failed_validation");
    await insertHistory(env.DB, {
      proposalId: proposal.id,
      runId: proposal.runId,
      action: "failed_validation",
      actor: input.actor,
      evidence: { reason: validation.reason },
    });
    return { status: "failed_validation", reason: validation.reason };
  }

  const created = await insertRuntimeVersion(env.DB, {
    config: next,
    status: "canary",
    proposalId: proposal.id,
    canaryPercent: 10,
    canaryCompanyId: CADDINGTON_COMPANY_ID,
  });
  await updateProposalStatus(env.DB, proposal.id, "canary");
  await insertHistory(env.DB, {
    proposalId: proposal.id,
    runId: proposal.runId,
    action: "canary",
    actor: input.actor,
    runtimeVersion: created.version,
    evidence: { canaryPercent: 10, canaryCompanyId: CADDINGTON_COMPANY_ID },
  });
  await recordAuditEvent(env.DB, {
    companyId: proposal.companyId,
    eventType: "quality_loop.canary_started",
    actor: input.actor,
    resourceType: "quality_proposal",
    resourceId: proposal.id,
    detail: { version: created.version },
  });
  return { status: "canary", version: created.version, reason: "Canary started at 10% / Caddington first" };
}

export function canaryShouldRollback(input: {
  baselineQuality: number;
  canaryQuality: number;
  baselineErrorRate: number;
  canaryErrorRate: number;
  baselineLatencyMs: number;
  canaryLatencyMs: number;
  permissionSafetyWorsened: boolean;
}): { rollback: boolean; reason: string } {
  if (input.permissionSafetyWorsened) {
    return { rollback: true, reason: "Permission-safety worsened on canary" };
  }
  if (input.canaryErrorRate > input.baselineErrorRate + 0.02) {
    return { rollback: true, reason: "Error rate worsened on canary" };
  }
  if (input.canaryQuality + 0.5 < input.baselineQuality) {
    return { rollback: true, reason: "Quality score worsened on canary" };
  }
  if (input.canaryLatencyMs > input.baselineLatencyMs * 1.15 + 500) {
    return { rollback: true, reason: "Latency worsened on canary" };
  }
  return { rollback: false, reason: "Canary within tolerance" };
}

export async function promoteOrRollbackCanary(
  env: Env,
  input: {
    version: number;
    proposalId: string;
    actor?: string;
    decision: ReturnType<typeof canaryShouldRollback>;
  },
) {
  if (input.decision.rollback) {
    await markRuntimeStatus(env.DB, input.version, "rolled_back", input.decision.reason);
    await updateProposalStatus(env.DB, input.proposalId, "rolled_back");
    await insertHistory(env.DB, {
      proposalId: input.proposalId,
      action: "rolled_back",
      actor: input.actor ?? "system:quality-loop",
      runtimeVersion: input.version,
      evidence: { reason: input.decision.reason },
    });
    return { status: "rolled_back" as const, reason: input.decision.reason };
  }
  await markRuntimeStatus(env.DB, input.version, "promoted");
  await updateProposalStatus(env.DB, input.proposalId, "promoted");
  await insertHistory(env.DB, {
    proposalId: input.proposalId,
    action: "promoted",
    actor: input.actor ?? "system:quality-loop",
    runtimeVersion: input.version,
    evidence: { reason: input.decision.reason },
  });
  return { status: "promoted" as const, reason: input.decision.reason };
}

export async function rollbackProposal(
  env: Env,
  input: { proposalId: string; actor: string; reason?: string },
): Promise<{ status: string; reason: string }> {
  const proposal = await getProposal(env.DB, input.proposalId);
  if (!proposal) return { status: "missing", reason: "Proposal not found" };
  if (proposal.status !== "canary" && proposal.status !== "promoted") {
    return { status: proposal.status, reason: "Nothing to roll back" };
  }
  const runtime = await getActiveRuntimeRow(env.DB);
  const version =
    runtime.canary?.proposalId === proposal.id
      ? runtime.canary.version
      : runtime.promoted?.proposalId === proposal.id
        ? runtime.promoted.version
        : null;
  if (version == null) {
    await updateProposalStatus(env.DB, proposal.id, "rolled_back");
    await insertHistory(env.DB, {
      proposalId: proposal.id,
      action: "rolled_back",
      actor: input.actor,
      evidence: { reason: "No runtime version bound; status rolled back" },
    });
    return { status: "rolled_back", reason: "Status rolled back; no bound runtime version" };
  }
  return promoteOrRollbackCanary(env, {
    version,
    proposalId: proposal.id,
    actor: input.actor,
    decision: { rollback: true, reason: input.reason ?? "Operator rollback" },
  });
}
