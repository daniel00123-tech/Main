import { describe, expect, it } from "vitest";
import whatsappRoutes from "../routes/whatsapp";
import oauthRoutes from "../routes/oauth";
import qualityLoopRoutes from "../routes/quality-loop";
import dailyImprovementRoutes from "../routes/daily-improvement";
import knowledgeIntakeRoutes from "../routes/knowledge-intake";
import portalChatRoutes from "../routes/portal-chat";
import engineeringFailureRoutes from "../routes/engineering-failures";
import { classifyScope } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";
import { assertProductionSuperstackCapabilities } from "./production-superstack";
import { PRODUCTION_LINEAGE_ID, PRODUCTION_SUPERSTACK_CAPABILITIES } from "./production-lineage";

function routePaths(app: { routes: Array<{ path: string; method: string }> }): string[] {
  return app.routes.map((route) => `${route.method} ${route.path}`);
}

describe("production superstack deploy guard", () => {
  it("imports every critical combined capability", () => {
    const asserted = assertProductionSuperstackCapabilities();
    expect(asserted.ok).toBe(true);
    expect(asserted.capabilities).toEqual(PRODUCTION_SUPERSTACK_CAPABILITIES);
    expect(PRODUCTION_LINEAGE_ID).toBe("elvex-b8da-superstack");
  });

  it("registers WhatsApp webhook, OAuth discovery, Portal Chat, and quality routes", () => {
    const whatsapp = routePaths(whatsappRoutes);
    expect(whatsapp.some((path) => path.includes("/api/webhooks/whatsapp"))).toBe(true);
    const oauth = routePaths(oauthRoutes);
    expect(oauth.some((path) => path.includes("/.well-known/oauth-authorization-server"))).toBe(true);
    expect(oauth.some((path) => path.includes("/.well-known/oauth-protected-resource"))).toBe(true);
    const portal = routePaths(portalChatRoutes);
    expect(portal.some((path) => path.includes("/chat/messages"))).toBe(true);
    const quality = routePaths(qualityLoopRoutes);
    expect(quality.some((path) => path.includes("/api/platform/quality-loop"))).toBe(true);
    const engineering = routePaths(engineeringFailureRoutes);
    expect(engineering.some((path) => path.includes("/api/internal/engineering-failures"))).toBe(true);
    const daily = routePaths(dailyImprovementRoutes);
    expect(daily.some((path) => path.includes("/api/platform/daily-improvement"))).toBe(true);
    expect(daily.some((path) => path.includes("/api/internal/cursor-engineering/claim"))).toBe(true);
    const intake = routePaths(knowledgeIntakeRoutes);
    expect(intake.some((path) => path.includes("/api/platform/knowledge-intake"))).toBe(true);
  });

  it("keeps shared channel-independent routing for email, process, and Xero", () => {
    expect(classifyScope("Search emails", buildConversationState({ userText: "Search emails" })).tool).toBe(
      "outlook_search_mailbox",
    );
    expect(classifyScope("What is the PO process?", buildConversationState({ userText: "What is the PO process?" })).tool).not.toMatch(
      /^xero_/,
    );
    expect(
      classifyScope("Tell me Xero sales this month.", buildConversationState({ userText: "Tell me Xero sales this month." }))
        .tool,
    ).toMatch(/^xero_/);
  });
});
