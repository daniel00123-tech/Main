#!/usr/bin/env node
"use strict";

const {
  BigChangeClient,
  configFromEnv,
  formatResponseForDisplay,
  isSuccessResponse,
  loadDotEnv,
} = require("./bigchangeClient");

async function main() {
  loadDotEnv();

  let result;
  try {
    const client = new BigChangeClient(configFromEnv());
    result = await client.call("listmethods");
  } catch (error) {
    if (error && error.name === "BigChangeConfigError") {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Connection test failed: ${error.message}`);
    return 1;
  }

  console.log("Connection succeeded. BigChange returned:");
  console.log(formatResponseForDisplay(result));
  return isSuccessResponse(result) ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`Unexpected error: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
