import type { Env } from "../../env";
import { getDailyImprovementConfig, markBootstrapCompleted } from "./store";
import { provisionDailyImprovementAutomations } from "./provision";
import { runDailyImprovementEngineering, runDailyImprovementQa, runDailyImprovementReport } from "./qa";
import { londonDateOf } from "./windows";

export async function bootstrapDailyImprovement(
  env: Env,
  now = new Date(),
): Promise<{
  skipped: boolean;
  reason: string;
  qa?: Awaited<ReturnType<typeof runDailyImprovementQa>>;
  report?: Awaited<ReturnType<typeof runDailyImprovementReport>>;
  engineering?: Awaited<ReturnType<typeof runDailyImprovementEngineering>>;
  provision?: Awaited<ReturnType<typeof provisionDailyImprovementAutomations>>;
}> {
  const config = await getDailyImprovementConfig(env.DB);
  if (config?.bootstrap_completed_at) {
    return { skipped: true, reason: "bootstrap already completed — refusing duplicate report" };
  }
  const provision = await provisionDailyImprovementAutomations(env.DB);
  const windowTo = now.toISOString();
  const windowFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const runDate = londonDateOf(now);
  const qa = await runDailyImprovementQa(env, now, { windowFrom, windowTo, runDate });
  const report = await runDailyImprovementReport(env, now, { runDate });
  const engineering = await runDailyImprovementEngineering(env, now, { runDate });
  await markBootstrapCompleted(env.DB);
  return { skipped: false, reason: "bootstrap completed", qa, report, engineering, provision };
}

export async function maybeRunDailyImprovementWindows(
  env: Env,
  now = new Date(),
  options?: { provision?: boolean },
): Promise<{ actions: string[] }> {
  const actions: string[] = [];
  if (options?.provision !== false) {
    try {
      await provisionDailyImprovementAutomations(env.DB);
    } catch {
      actions.push("provision_failed");
    }
  }
  const { decideDailyImprovementWindow } = await import("./windows");
  const due = decideDailyImprovementWindow(now);
  for (const item of due) {
    if (item.kind === "QA") {
      const result = await runDailyImprovementQa(env, now, { runDate: item.londonDate });
      actions.push(`qa:${result.reason}`);
    }
    if (item.kind === "REPORT") {
      const result = await runDailyImprovementReport(env, now, { runDate: item.londonDate });
      actions.push(`report:${result.reason}`);
    }
    if (item.kind === "ENGINEERING") {
      const result = await runDailyImprovementEngineering(env, now, { runDate: item.londonDate });
      actions.push(`engineering:${result.reason}`);
    }
  }
  return { actions };
}
