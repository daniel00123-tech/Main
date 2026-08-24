import { describe, expect, it } from "vitest";
import {
  buildExtendedHealthResponse,
  buildLivenessHealthResponse,
} from "../src/health/status";
import { computeOverallHealth } from "../src/health/probes";
import { notConfiguredConnector } from "../src/connectors/not-configured";
import { describeCapability, isHighRisk } from "../src/connectors/capabilities";
import { chunkText } from "../src/documents/chunking";

describe("health status", () => {
  const identity = {
    company: "EL Business",
    companySlug: "el-business",
    environment: "production",
    serviceName: "el-business-mcp",
  };
  const versions = { mcpVersion: "1.0.0", coreVersion: "1.0.0" };

  it("builds liveness response", () => {
    const response = buildLivenessHealthResponse({ identity, versions });
    expect(response.company).toBe("EL Business");
    expect(response.coreVersion).toBe("1.0.0");
    expect(response.ok).toBe(true);
  });

  it("builds extended response with not_configured knowledge", () => {
    const response = buildExtendedHealthResponse({ identity, versions });
    expect(response.knowledge.status).toBe("not_configured");
    expect(response.structuredData.status).toBe("not_configured");
  });

  it("computes overall health from components", () => {
    expect(
      computeOverallHealth([{ healthy: true }, { healthy: true }])
    ).toBe("healthy");
    expect(
      computeOverallHealth([{ healthy: true }, { healthy: false }])
    ).toBe("degraded");
  });
});

describe("connector helpers", () => {
  it("returns not_configured connector payload", () => {
    expect(notConfiguredConnector("xero").status).toBe("not_configured");
  });

  it("marks financial send capabilities as high risk", () => {
    expect(isHighRisk(describeCapability("SEND").risk)).toBe(true);
  });
});

describe("chunking", () => {
  it("splits long text into overlapping chunks", () => {
    const text = "a".repeat(2000);
    const chunks = chunkText(text, 900, 120);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
