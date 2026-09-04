import { proposeImprovements } from "./proposals";
import type { QualityPattern } from "./patterns";
import { insertProposals, listProposalsForRun } from "./store";

export async function reconstructMissingProposals(
  db: D1Database,
  runId: string,
  patterns: QualityPattern[],
): Promise<{ inserted: number; fingerprints: string[] }> {
  const existing = await listProposalsForRun(db, runId);
  const seen = new Set(existing.map((row) => row.fingerprint));
  const drafts = proposeImprovements(patterns).filter((draft) => !seen.has(draft.fingerprint));
  if (drafts.length === 0) return { inserted: 0, fingerprints: [] };
  const pretest: Record<string, unknown> = {};
  for (const draft of drafts) {
    pretest[draft.fingerprint] = {
      accepted: !draft.engineeringRequired && draft.autoApplyable,
      reason: draft.engineeringRequired
        ? "Reconstructed from persisted quality patterns. ENGINEERING CHANGE REQUIRED — no production apply."
        : "Reconstructed from persisted quality patterns. Safe config/policy patch pending approval.",
      reconstructed: true,
    };
  }
  await insertProposals(db, runId, drafts, pretest);
  return { inserted: drafts.length, fingerprints: drafts.map((draft) => draft.fingerprint) };
}
