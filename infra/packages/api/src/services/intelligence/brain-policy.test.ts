import { describe, expect, it } from "vitest";
import { classifyBrainChannelRole, resolveBrainPolicy } from "./brain-policy.js";

const SHADOW_ENV = {
  OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
  OPENAI_BRAIN_ENABLED: "true",
  OPENAI_BRAIN_MODE: "openai_shadow",
  OPENAI_BRAIN_COMPANY_IDS: "co_el",
};

describe("brain policy", () => {
  it("classifies PA, request, and chatbot roles", () => {
    expect(classifyBrainChannelRole("portal")).toBe("pa");
    expect(classifyBrainChannelRole("portal_chat")).toBe("pa");
    expect(classifyBrainChannelRole("whatsapp")).toBe("request");
    expect(classifyBrainChannelRole("chatgpt")).toBe("chatbot");
    expect(classifyBrainChannelRole("mcp")).toBe("chatbot");
    expect(classifyBrainChannelRole(null)).toBe("internal");
  });

  it("keeps Caddington and HT on Cloudflare even when OpenAI is enabled", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_primary",
      OPENAI_BRAIN_COMPANY_IDS: "co_el",
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

  it("keeps unscoped openai_shadow off the user-visible path", () => {
    const el = resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_el" });
    expect(el.shadow).toBe(true);
    expect(el.useOpenAi).toBe(false);
    expect(el.mode).toBe("openai_shadow");
    expect(el.role).toBe("internal");
    expect(el.userVisibleBrain).toBe("cloudflare");
    expect(el.designatedBrain).toBe("openai");
    expect(resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_caddington" }).shadow).toBe(false);
    expect(resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_ht" }).useOpenAi).toBe(false);
  });

  it("makes OpenAI the user-visible brain for EL PA and WhatsApp requests", () => {
    const pa = resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_el", channel: "portal_chat" });
    expect(pa.role).toBe("pa");
    expect(pa.useOpenAi).toBe(true);
    expect(pa.shadow).toBe(false);
    expect(pa.userVisibleBrain).toBe("openai");
    expect(pa.reason).toBe("pa_request_openai_brain");
    expect(pa.fallbackToCloudflare).toBe(true);

    const request = resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_el", channel: "whatsapp" });
    expect(request.role).toBe("request");
    expect(request.useOpenAi).toBe(true);
    expect(request.shadow).toBe(false);
    expect(request.userVisibleBrain).toBe("openai");

    const portalAlias = resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_el", channel: "portal" });
    expect(portalAlias.role).toBe("pa");
    expect(portalAlias.useOpenAi).toBe(true);
  });

  it("does not send ChatGPT MCP through the OpenAI brain", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_primary",
      OPENAI_BRAIN_COMPANY_IDS: "co_el",
    };
    const chatgpt = resolveBrainPolicy({ env, companyId: "co_el", channel: "chatgpt" });
    expect(chatgpt.reason).toBe("chatgpt_stays_direct_tools");
    expect(chatgpt.role).toBe("chatbot");
    expect(chatgpt.useOpenAi).toBe(false);
    expect(chatgpt.userVisibleBrain).toBe("cloudflare");
    expect(resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_el", channel: "mcp" }).reason).toBe(
      "chatgpt_stays_direct_tools",
    );
  });

  it("does not promote Caddington or HT PA/request turns onto OpenAI", () => {
    expect(resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_caddington", channel: "portal" }).useOpenAi).toBe(false);
    expect(resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_ht", channel: "whatsapp" }).useOpenAi).toBe(false);
  });

  it("defaults an unconfigured future tenant to Cloudflare", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_primary",
      OPENAI_BRAIN_COMPANY_IDS: "co_el",
    };
    const future = resolveBrainPolicy({ env, companyId: "co_newco" });
    expect(future.mode).toBe("cloudflare");
    expect(future.useOpenAi).toBe(false);
    expect(future.shadow).toBe(false);
    expect(future.reason).toBe("tenant_not_allowlisted");
  });
});
