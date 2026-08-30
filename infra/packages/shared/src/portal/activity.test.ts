import { describe, expect, it } from "vitest";
import { buildCustomerActivityFeed } from "./activity";
import type { AuditEvent } from "../types";

function event(partial: Partial<AuditEvent> & Pick<AuditEvent, "eventType" | "actor">): AuditEvent {
  return {
    id: partial.id ?? "evt_1",
    companyId: "co_test",
    resourceType: partial.resourceType ?? null,
    resourceId: partial.resourceId ?? null,
    detail: partial.detail ?? {},
    createdAt: partial.createdAt ?? "2026-08-28T20:46:00.000Z",
    ...partial,
  };
}

describe("buildCustomerActivityFeed", () => {
  it("collapses microsoft scheduler/queue sync noise into one customer event", () => {
    const feed = buildCustomerActivityFeed([
      event({
        id: "1",
        eventType: "connector.sync_completed",
        actor: "system:microsoft-scheduler",
        detail: { provider: "microsoft_365" },
        createdAt: "2026-08-28T20:46:07.668Z",
      }),
      event({
        id: "2",
        eventType: "connector.sync_completed",
        actor: "system:microsoft-queue",
        detail: { provider: "microsoft_365" },
        createdAt: "2026-08-28T20:46:06.673Z",
      }),
      event({
        id: "3",
        eventType: "connector.sync_started",
        actor: "system:microsoft-scheduler",
        detail: { provider: "microsoft_365" },
        createdAt: "2026-08-28T20:46:03.419Z",
      }),
    ]);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe("Microsoft 365");
    expect(feed[0]?.description).toBe("Synced successfully");
  });

  it("hides stale routing-probe failures once later connector success exists", () => {
    const feed = buildCustomerActivityFeed([
      event({
        id: "ok",
        eventType: "connector.connected",
        actor: "system:connector-mirror",
        detail: { provider: "xero", source: "company_mcp_registry" },
        createdAt: "2026-08-30T12:20:00.000Z",
      }),
      event({
        id: "probe-fail",
        eventType: "mcp.execution_failed",
        actor: "EL probe",
        resourceId: "system_health",
        detail: { tool: "system_health", reason: "routing-probe" },
        createdAt: "2026-08-30T10:00:00.000Z",
      }),
    ]);
    expect(feed.some((item) => item.description === "AI request failed")).toBe(false);
    expect(feed[0]?.description).toBe("Connected");
  });

  it("hides routine company.accessed and execution success noise", () => {
    const feed = buildCustomerActivityFeed([
      event({ eventType: "company.accessed", actor: "user@example.com" }),
      event({ eventType: "mcp.execution_succeeded", actor: "ChatGPT" }),
      event({ eventType: "auth.login", actor: "morghan@caddington.com" }),
    ]);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.description).toBe("Signed in");
  });
});
