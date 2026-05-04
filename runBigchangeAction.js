#!/usr/bin/env node
"use strict";

const {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  formatResponseForDisplay,
  loadDotEnv,
} = require("./bigchangeClient");

function parseArgs(argv) {
  const [, , action, ...rest] = argv;
  if (!action) {
    throw new Error("Usage: node runBigchangeAction.js <action> [--param KEY=VALUE]");
  }

  const params = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token !== "--param") {
      throw new Error(`Unknown argument: ${token}`);
    }

    const rawParam = rest[index + 1];
    index += 1;
    if (!rawParam || !rawParam.includes("=")) {
      throw new Error("--param must be followed by KEY=VALUE");
    }

    const separatorIndex = rawParam.indexOf("=");
    const key = rawParam.slice(0, separatorIndex);
    const value = rawParam.slice(separatorIndex + 1);
    params[key] = value;
  }

  return { action, params };
}

async function main() {
  try {
    const { action, params } = parseArgs(process.argv);
    loadDotEnv();
    const client = new BigChangeClient(configFromEnv());
    const result = await client.call(action, params);
    console.log(formatResponseForDisplay(result));
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      return 2;
    }

    console.error(`BigChange action failed: ${error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
