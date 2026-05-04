#!/usr/bin/env node
"use strict";

const {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  loadDotEnv,
} = require("./bigchangeClient");

function parseArgs(argv) {
  const options = {
    end: formatDateTime(new Date()),
    limit: 10,
    start: formatDateTime(daysAgo(90)),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    if (token === "--start") {
      options.start = requireValue(token, value);
      index += 1;
    } else if (token === "--end") {
      options.end = requireValue(token, value);
      index += 1;
    } else if (token === "--limit") {
      options.limit = Number(requireValue(token, value));
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function requireValue(name, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function formatDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function extractRecords(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (!response || typeof response !== "object") {
    return [];
  }

  for (const key of ["Jobs", "jobs", "Data", "data", "Result", "result"]) {
    const value = response[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function extractJobNumber(job) {
  for (const key of [
    "JobCustRef",
    "jobCustRef",
    "JobCustomerReference",
    "JobReference",
    "JobRef",
    "jobRef",
    "JobId",
    "jobId",
    "Id",
    "id",
  ]) {
    if (job[key] !== undefined && job[key] !== null && job[key] !== "") {
      return String(job[key]);
    }
  }
  return null;
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    loadDotEnv();

    const client = new BigChangeClient(configFromEnv());
    const response = await client.call("Jobs", {
      Completed: 1,
      End: options.end,
      Myjobs: 0,
      Start: options.start,
      Unallocated: 1,
    });

    const records = extractRecords(response);
    const jobNumbers = records
      .map(extractJobNumber)
      .filter(Boolean)
      .slice(0, options.limit);

    if (jobNumbers.length === 0) {
      console.log(
        `No job numbers found between ${options.start} and ${options.end}.`,
      );
      console.log("Raw response shape:");
      console.log(
        JSON.stringify(
          response && typeof response === "object" ? Object.keys(response) : response,
          null,
          2,
        ),
      );
      return 0;
    }

    console.log(`Job numbers between ${options.start} and ${options.end}:`);
    for (const jobNumber of jobNumbers) {
      console.log(jobNumber);
    }
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Job-number extraction failed: ${error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
