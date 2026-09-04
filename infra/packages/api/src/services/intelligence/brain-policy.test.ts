import { describe, expect, it } from "vitest";
import { resolveBrainPolicy } from "./brain-policy.js";

describe("brain policy", () => {
  it("keeps Caddington and HT on Cloudflare even when OpenAI is enabled", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_primary",
    };
    expect(resolveBrainPolicy({ env, companyId: "co_caddington" }).useOpenAi).toBe(false);
    expect(resolveBrainPolicy({ env, companyId: "co_ht" }).useOpenAi).toBe(false);
    expect(resolveBrainPolicy({ env, companyId: "co_el" }).useOpenAi).toBe(true);
  });

  it("stays off without a key or flag", () => {
    expect(resolveBrainPolicy({ env: { OPENAI_BRAIN_ENABLED: "true" }, companyId: "co_el" }).reason).toBe("missing_key");
    expect(
      resolveBrainPolicy({
        env: { OPENAI_API_KEY: "sk-test-key-1234567890abcdef", OPENAI_BRAIN_MODE: "openai_primary" },
        companyId: "co_el",
      }).useOpenAi,
    ).toBe(false);
  });

  it("does not send ChatGPT MCP through the OpenAI brain", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_primary",
    };
    expect(resolveBrainPolicy({ env, companyId: "co_el", channel: "chatgpt" }).reason).toBe("chatgpt_stays_direct_tools");
  });
});
