import { describe, expect, it } from "vitest";
import {
  MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL,
  MICROSOFT_LEGACY_GRAPH_WEBHOOK_URL,
} from "@infra/shared";
import { isGraphSubscriptionConflict } from "./microsoft-graph";
import {
  buildMicrosoftSubscriptionClientState,
  graphSubscriptionNeedsNotificationUrlCutover,
  MICROSOFT_GRAPH_WEBHOOK_PATH,
  microsoftGraphNotificationUrl,
  shouldReuseActiveGraphSubscription,
  verifyMicrosoftSubscriptionClientState,
} from "./microsoft-graph-subscriptions";
import {
  MICROSOFT_KNOWLEDGE_INGEST_DLQ,
  MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
  MICROSOFT_QUEUE_MAX_RETRIES,
} from "./microsoft-queue";

describe("Microsoft Graph subscriptions (CMD15)", () => {
  const env = {
    SESSION_SECRET: "test-secret-cmd15",
    INFRA_PUBLIC_API_URL: "https://api.infrastack.app",
  } as import("../env").Env;

  it("uses stable webhook path", () => {
    expect(MICROSOFT_GRAPH_WEBHOOK_PATH).toBe("/api/webhooks/microsoft/graph");
  });

  it("builds new subscription URLs from INFRA_PUBLIC_API_URL", () => {
    expect(microsoftGraphNotificationUrl(env)).toBe(MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL);
    expect(microsoftGraphNotificationUrl({} as import("../env").Env)).toBe(
      MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL,
    );
    expect(
      microsoftGraphNotificationUrl({
        INFRA_PUBLIC_API_URL: "https://infra-api.daniel-dwyer123.workers.dev",
      } as import("../env").Env),
    ).toBe(MICROSOFT_LEGACY_GRAPH_WEBHOOK_URL);
  });

  it("does not cut over when the stored URL already matches current config", () => {
    expect(
      graphSubscriptionNeedsNotificationUrlCutover(
        MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL,
        MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL,
      ),
    ).toBe(false);
    expect(
      graphSubscriptionNeedsNotificationUrlCutover(
        `${MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL}/`,
        MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL,
      ),
    ).toBe(false);
  });

  it("cut over renewals that still point at workers.dev", () => {
    expect(
      graphSubscriptionNeedsNotificationUrlCutover(
        MICROSOFT_LEGACY_GRAPH_WEBHOOK_URL,
        MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL,
      ),
    ).toBe(true);
  });

  it("reuses healthy active subscriptions unless force or expiry", () => {
    const expiresAt = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    expect(
      shouldReuseActiveGraphSubscription({
        status: "active",
        graphSubscriptionId: "sub-1",
        expiresAt,
      }),
    ).toEqual({ reuse: true, reason: "already_active" });
    expect(
      shouldReuseActiveGraphSubscription({
        status: "active",
        graphSubscriptionId: "sub-1",
        expiresAt,
        force: true,
      }),
    ).toEqual({ reuse: false, reason: "force" });
    expect(
      shouldReuseActiveGraphSubscription({
        status: "active",
        graphSubscriptionId: "sub-1",
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      }),
    ).toEqual({ reuse: false, reason: "expiring" });
  });

  it("detects Graph duplicate-subscription conflicts for delete-then-create fallback", () => {
    expect(isGraphSubscriptionConflict(new Error("A subscription already exists"))).toBe(true);
    expect(isGraphSubscriptionConflict(new Error("validation failed"))).toBe(false);
  });

  it("validates clientState HMAC authenticity", () => {
    const state = buildMicrosoftSubscriptionClientState(env, {
      companyId: "co_test",
      sourceId: "mss_test",
    });
    expect(
      verifyMicrosoftSubscriptionClientState(env, {
        companyId: "co_test",
        sourceId: "mss_test",
        clientState: state,
      }),
    ).toBe(true);
    expect(
      verifyMicrosoftSubscriptionClientState(env, {
        companyId: "co_other",
        sourceId: "mss_test",
        clientState: state,
      }),
    ).toBe(false);
  });
});

describe("Microsoft queue DLQ configuration (CMD15)", () => {
  it("matches wrangler consumer retry + dead letter design", () => {
    expect(MICROSOFT_KNOWLEDGE_INGEST_QUEUE).toBe("microsoft-knowledge-ingest");
    expect(MICROSOFT_KNOWLEDGE_INGEST_DLQ).toBe("microsoft-knowledge-ingest-dlq");
    expect(MICROSOFT_QUEUE_MAX_RETRIES).toBe(5);
  });
});
