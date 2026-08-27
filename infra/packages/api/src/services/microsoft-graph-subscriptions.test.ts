import { describe, expect, it } from "vitest";
import {
  buildMicrosoftSubscriptionClientState,
  MICROSOFT_GRAPH_WEBHOOK_PATH,
  verifyMicrosoftSubscriptionClientState,
} from "./microsoft-graph-subscriptions";
import {
  MICROSOFT_KNOWLEDGE_INGEST_DLQ,
  MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
  MICROSOFT_QUEUE_MAX_RETRIES,
} from "./microsoft-queue";

describe("Microsoft Graph subscriptions (CMD15)", () => {
  const env = { SESSION_SECRET: "test-secret-cmd15" } as import("../env").Env;

  it("uses stable webhook path", () => {
    expect(MICROSOFT_GRAPH_WEBHOOK_PATH).toBe("/api/webhooks/microsoft/graph");
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
