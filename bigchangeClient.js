const fs = require("node:fs");

const DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx";

class BigChangeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BigChangeConfigError";
  }
}

function loadDotEnv(path = ".env") {
  if (!fs.existsSync(path)) {
    return;
  }

  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = line.split("=");
    const value = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key.trim()]) {
      process.env[key.trim()] = value;
    }
  }
}

function configFromEnv() {
  const missing = [
    "BIGCHANGE_USERNAME",
    "BIGCHANGE_PASSWORD",
    "BIGCHANGE_COMPANY_KEY",
  ].filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new BigChangeConfigError(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  const keyLocation = (
    process.env.BIGCHANGE_KEY_LOCATION || "header"
  ).toLowerCase();
  if (!["header", "query"].includes(keyLocation)) {
    throw new BigChangeConfigError(
      "BIGCHANGE_KEY_LOCATION must be either 'header' or 'query'",
    );
  }

  const timeoutSeconds = Number(process.env.BIGCHANGE_TIMEOUT_SECONDS || "30");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new BigChangeConfigError("BIGCHANGE_TIMEOUT_SECONDS must be a number");
  }

  return {
    baseUrl: process.env.BIGCHANGE_BASE_URL || DEFAULT_BASE_URL,
    username: process.env.BIGCHANGE_USERNAME,
    password: process.env.BIGCHANGE_PASSWORD,
    companyKey: process.env.BIGCHANGE_COMPANY_KEY,
    keyLocation,
    keyName: process.env.BIGCHANGE_KEY_NAME || "key",
    timeoutSeconds,
  };
}

class BigChangeClient {
  constructor(config) {
    this.config = config;
  }

  async call(action, params = {}) {
    const url = new URL(this.config.baseUrl);
    url.searchParams.set("Action", action);
    url.searchParams.set("Format", "JSON");

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${this.config.username}:${this.config.password}`,
        "utf8",
      ).toString("base64")}`,
      "User-Agent": "cursor-bigchange-prototype/0.1",
    };

    if (this.config.keyLocation === "header") {
      headers[this.config.keyName] = this.config.companyKey;
    } else {
      url.searchParams.set(this.config.keyName, this.config.companyKey);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSeconds * 1000,
    );

    let response;
    try {
      if (typeof fetch !== "function") {
        throw new Error("Node.js 18 or newer is required because this prototype uses fetch");
      }
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          `BigChange request timed out after ${this.config.timeoutSeconds}s`,
        );
      }
      throw new Error(`Could not reach BigChange: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`BigChange HTTP error ${response.status}: ${body.slice(0, 500)}`);
    }

    return parseResponse(body);
  }
}

function parseResponse(body) {
  const stripped = body.trim();
  if (!stripped) {
    return "";
  }

  try {
    return JSON.parse(stripped);
  } catch {
    return stripped;
  }
}

function formatResponseForDisplay(response) {
  return typeof response === "string" ? response : JSON.stringify(response, null, 2);
}

function getServiceCode(response) {
  if (response && typeof response === "object" && "Code" in response) {
    const code = Number(response.Code);
    return Number.isInteger(code) ? code : null;
  }

  if (typeof response === "string") {
    const jsonMatch = response.match(/Code\s*:\s*(-?\d+)/);
    if (jsonMatch) {
      return Number(jsonMatch[1]);
    }

    const xmlMatch = response.match(/<Code>\s*(-?\d+)\s*<\/Code>/i);
    if (xmlMatch) {
      return Number(xmlMatch[1]);
    }
  }

  return null;
}

function isSuccessResponse(response) {
  const code = getServiceCode(response);
  // Some read endpoints return data directly rather than the Code/Result wrapper.
  return code === null || code === 0;
}

module.exports = {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  formatResponseForDisplay,
  isSuccessResponse,
  loadDotEnv,
};
