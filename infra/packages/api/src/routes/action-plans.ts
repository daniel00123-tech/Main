import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { loadSession, requireAuth, type AuthVariables } from "../auth/middleware";
import { getCompanyBySlug } from "../services/control-plane";
import { userHasCompanyAccess } from "../permissions/service";
import {
  approveActionPlan,
  cancelActionPlan,
  confirmActionPlan,
  getActionPlan,
  isPlanStale,
  listActionPlans,
  markPlanStale,
  rejectActionPlan,
} from "../services/action-engine/action-engine";
import { revalidateXeroPlanTargets } from "../services/action-engine/xero-planner";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const actionPlans = new Hono<AppEnv>();

async function resolveCompany(c: Context<AppEnv>) {
  const slug = c.req.param("slug");
  if (!slug) return null;
  const company = await getCompanyBySlug(c.env.DB, slug);
  if (!company) return null;
  const user = c.get("user");
  if (!user.isPlatformAdmin && !userHasCompanyAccess(user, company.id)) return null;
  return company;
}

const authed = [loadSession, requireAuth] as const;

actionPlans.get("/api/companies/:slug/actions", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const status = c.req.query("status");
  const plans = await listActionPlans(c.env.DB, company.id, { limit: 100 });
  const filtered = status ? plans.filter((plan) => plan.status === status) : plans;
  return c.json({ plans: filtered });
});

actionPlans.get("/api/companies/:slug/actions/:planId", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const planId = c.req.param("planId");
  if (!planId) return c.json({ error: "Plan id required" }, 400);
  const plan = await getActionPlan(c.env.DB, company.id, planId);
  if (!plan) return c.json({ error: "Action plan not found" }, 404);
  return c.json({ plan });
});

actionPlans.post("/api/companies/:slug/actions/:planId/confirm", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const planId = c.req.param("planId");
  if (!planId) return c.json({ error: "Plan id required" }, 400);
  const body = (await c.req.json<{ confirmationToken?: string }>().catch(() => ({
    confirmationToken: undefined,
  }))) as { confirmationToken?: string };
  const user = c.get("user");
  const plan = await getActionPlan(c.env.DB, company.id, planId);
  if (!plan) return c.json({ error: "Action plan not found" }, 404);

  if (plan.connectorInstanceId && plan.provider === "xero") {
    try {
      const live = await revalidateXeroPlanTargets({
        env: c.env,
        companyId: company.id,
        instanceId: plan.connectorInstanceId,
        actor: user.email,
        requestedAction: plan.requestedAction,
        targets: plan.targets,
      });
      if (isPlanStale(plan, live.fingerprint)) {
        await markPlanStale(c.env.DB, { companyId: company.id, planId, actor: user.email });
        return c.json(
          {
            error: "Source state changed since plan was created.",
            code: "PLAN_STALE",
            liveTargets: live.targets,
          },
          409,
        );
      }
    } catch {
      return c.json(
        { error: "Unable to revalidate plan against live Xero.", code: "REVALIDATION_FAILED" },
        503,
      );
    }
  }

  const result = await confirmActionPlan(c.env.DB, {
    companyId: company.id,
    planId,
    actor: user.email,
    confirmationToken: body.confirmationToken ?? null,
  });
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
  return c.json(result);
});

actionPlans.post("/api/companies/:slug/actions/:planId/cancel", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const planId = c.req.param("planId");
  if (!planId) return c.json({ error: "Plan id required" }, 400);
  const user = c.get("user");
  const plan = await cancelActionPlan(c.env.DB, {
    companyId: company.id,
    planId,
    actor: user.email,
  });
  if (!plan) return c.json({ error: "Action plan not found" }, 404);
  return c.json({ plan });
});

actionPlans.post("/api/companies/:slug/actions/:planId/approve", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const planId = c.req.param("planId");
  if (!planId) return c.json({ error: "Plan id required" }, 400);
  const user = c.get("user");
  const result = await approveActionPlan(c.env.DB, {
    companyId: company.id,
    planId,
    actor: user.email,
  });
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
  return c.json({ plan: result.plan });
});

actionPlans.post("/api/companies/:slug/actions/:planId/reject", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const planId = c.req.param("planId");
  if (!planId) return c.json({ error: "Plan id required" }, 400);
  const body = (await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }))) as {
    reason?: string;
  };
  const user = c.get("user");
  const result = await rejectActionPlan(c.env.DB, {
    companyId: company.id,
    planId,
    actor: user.email,
    reason: body.reason,
  });
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
  return c.json({ plan: result.plan });
});

export default actionPlans;
