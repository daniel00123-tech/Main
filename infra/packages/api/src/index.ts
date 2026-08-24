import { Hono } from "hono";
import { cors } from "hono/cors";
import { CONNECTOR_CATALOGUE } from "@infra/shared";
import type { Env } from "./env";
import {
  getCompanyById,
  getCompanyBySlug,
  getCompanyOverview,
  getConnectorInstance,
  getCreditBalance,
  getMcpEnvironment,
  getPlatformSummary,
  listAuditEvents,
  listCompanies,
  listConnectorInstances,
  listMcpEnvironments,
  listSyncHistory,
  runMcpHealthCheck,
} from "./services/control-plane";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/", (c) =>
  c.json({
    name: "INFRA",
    description: "Administration and control platform for business AI infrastructure",
    version: "0.1.0",
    role: "control_plane",
  }),
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }),
);

app.get("/api/summary", async (c) => {
  const summary = await getPlatformSummary(c.env.DB);
  return c.json(summary);
});

app.get("/api/connectors/catalogue", (c) => c.json(CONNECTOR_CATALOGUE));

app.get("/api/connectors/catalogue/:slug", (c) => {
  const connector = CONNECTOR_CATALOGUE.find((item) => item.slug === c.req.param("slug"));
  if (!connector) return c.json({ error: "Connector not found" }, 404);
  return c.json(connector);
});

app.get("/api/companies", async (c) => {
  const companies = await listCompanies(c.env.DB);
  return c.json(companies);
});

app.get("/api/companies/:slug", async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  return c.json(company);
});

app.get("/api/companies/:slug/overview", async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const overview = await getCompanyOverview(c.env.DB, company.id);
  return c.json(overview);
});

app.get("/api/mcp-environments", async (c) => {
  const companyId = c.req.query("companyId");
  const environments = await listMcpEnvironments(c.env.DB, companyId ?? undefined);
  return c.json(environments);
});

app.get("/api/mcp-environments/:id", async (c) => {
  const environment = await getMcpEnvironment(c.env.DB, c.req.param("id"));
  if (!environment) return c.json({ error: "MCP environment not found" }, 404);
  return c.json(environment);
});

app.post("/api/mcp-environments/:id/health-check", async (c) => {
  const result = await runMcpHealthCheck(c.env, c.req.param("id"));
  if (!result) return c.json({ error: "MCP environment not found" }, 404);
  return c.json(result);
});

app.get("/api/connector-instances", async (c) => {
  const companyId = c.req.query("companyId");
  const instances = await listConnectorInstances(c.env.DB, companyId ?? undefined);
  return c.json(instances);
});

app.get("/api/connector-instances/:id", async (c) => {
  const instance = await getConnectorInstance(c.env.DB, c.req.param("id"));
  if (!instance) return c.json({ error: "Connector instance not found" }, 404);
  return c.json(instance);
});

app.get("/api/connector-instances/:id/sync-history", async (c) => {
  const instance = await getConnectorInstance(c.env.DB, c.req.param("id"));
  if (!instance) return c.json({ error: "Connector instance not found" }, 404);
  const history = await listSyncHistory(c.env.DB, instance.id);
  return c.json(history);
});

app.get("/api/audit-events", async (c) => {
  const companyId = c.req.query("companyId");
  const limit = Number(c.req.query("limit") ?? "20");
  const events = await listAuditEvents(c.env.DB, companyId ?? undefined, limit);
  return c.json(events);
});

app.get("/api/companies/:id/credit-balance", async (c) => {
  const company = await getCompanyById(c.env.DB, c.req.param("id"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const balance = await getCreditBalance(c.env.DB, company.id);
  return c.json(balance ?? { companyId: company.id, balanceCents: 0, currency: "GBP" });
});

export default app;
