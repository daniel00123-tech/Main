import { describe, expect, it } from "vitest";
import {
  classifyOpenAiHttpFailure,
  extractOpenAiResponses,
  hasOpenAiApiKey,
  isTrueProviderFailure,
  normaliseOpenAiToolName,
  redactOpenAiError,
  runOpenAiResponses,
} from "./openai-responses.js";

describe("openai responses adapter", () => {
  it("treats a missing key as a non-throwing provider miss", async () => {
    expect(hasOpenAiApiKey({})).toBe(false);
    const result = await runOpenAiResponses({}, { system: "You are INFRA.", user: "hello" });
    expect(result.failure).toBe("missing_key");
    expect(result.text).toBe("");
    expect(result.usage.costBasis).toBe("unknown");
    expect(result.usage.estimatedCostUsd).toBeNull();
  });

  it("classifies transport failures without treating denials as provider failure", () => {
    expect(classifyOpenAiHttpFailure(401)).toBe("invalid_key");
    expect(classifyOpenAiHttpFailure(429)).toBe("rate_limit");
    expect(classifyOpenAiHttpFailure(503)).toBe("upstream_5xx");
    expect(isTrueProviderFailure("timeout")).toBe(true);
    expect(isTrueProviderFailure("upstream_5xx")).toBe(true);
    expect(isTrueProviderFailure("rate_limit")).toBe(true);
    expect(isTrueProviderFailure("unavailable")).toBe(true);
    expect(isTrueProviderFailure("invalid_key")).toBe(false);
    expect(isTrueProviderFailure("missing_key")).toBe(false);
    expect(isTrueProviderFailure("malformed")).toBe(false);
  });

  it("redacts secrets from adapter errors", () => {
    expect(redactOpenAiError("Bearer sk-abc123456789 and api_key=secret-value")).not.toMatch(/sk-abc|secret-value/);
  });

  it("omits tools for a no-connector smoke prompt", async () => {
    const result = await runOpenAiResponses({}, { system: "probe", user: "Reply with the single word pong", permittedTools: [] });
    expect(result.failure).toBe("missing_key");
    expect(result.usage.model).toMatch(/luna|terra|sol|gpt-/);
  });

  it("extracts function calls and usage from a Responses payload", () => {
    const extracted = extractOpenAiResponses({
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "outlook_list_messages",
          arguments: JSON.stringify({ mailboxAddress: "info@elvexpropertyservices.com" }),
        },
      ],
      usage: { input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 4 } },
    });
    expect(extracted.toolCalls?.[0]?.name).toBe("outlook_list_messages");
    expect(extracted.usage?.cachedTokens).toBe(4);
    const prefixed = extractOpenAiResponses({
      output: [{ type: "function_call", name: "functions.list_documents", arguments: "{}" }],
    });
    expect(prefixed.toolCalls?.[0]?.name).toBe("list_documents");
    expect(normaliseOpenAiToolName("functions.list_documents")).toBe("list_documents");
  });
});
