#!/usr/bin/env node
"use strict";

const {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  loadDotEnv,
} = require("./bigchangeClient");

const ACTIONED_TAG_ID = 314031;
const DEFAULT_PAGE_SIZE = 5000;

function parseArgs(argv) {
  const now = new Date();
  const options = {
    end: formatDateTime(now),
    execute: false,
    pageSize: DEFAULT_PAGE_SIZE,
    queryStart: `${now.getUTCFullYear()}-01-01 00:00:00`,
    start: formatDateTime(daysAgo(28, now)),
    tagId: ACTIONED_TAG_ID,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const [name, inlineValue] = splitOption(argv[index]);
    const nextValue = inlineValue ?? argv[index + 1];

    if (name === "--execute") {
      options.execute = true;
    } else if (name === "--start") {
      options.start = requireValue(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else if (name === "--end") {
      options.end = requireValue(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else if (name === "--query-start") {
      options.queryStart = requireValue(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else if (name === "--page-size") {
      options.pageSize = parsePositiveInteger(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else if (name === "--tag-id") {
      options.tagId = parsePositiveInteger(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else {
      throw new Error(`Unknown argument: ${name}`);
    }
  }

  return options;
}

function splitOption(token) {
  const separatorIndex = token.indexOf("=");
  if (separatorIndex === -1) {
    return [token, undefined];
  }
  return [token.slice(0, separatorIndex), token.slice(separatorIndex + 1)];
}

function requireValue(name, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePositiveInteger(name, value) {
  const parsed = Number(requireValue(name, value));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function daysAgo(days, fromDate) {
  const date = new Date(fromDate);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function formatDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseBigChangeDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resultIsPlainComplete(value) {
  const normalised = String(value ?? "").trim().toLowerCase();
  return normalised === "complete" || normalised === "completed";
}

function isCompletedStatus(job) {
  const status = String(job.Status ?? "").trim().toLowerCase();
  return (
    status === "completed" ||
    status === "completed with issues" ||
    Number(job.StatusId) === 12 ||
    Number(job.StatusId) === 13
  );
}

function isUnactioned(job) {
  return String(job.Actioned ?? "").trim().toLowerCase() !== "yes";
}

function isNotAlreadyFlaggedActioned(job) {
  return String(job.CurrentFlag ?? "").trim().toLowerCase() !== "actioned";
}

function isCompletedWithinWindow(job, options) {
  const statusDate = parseBigChangeDate(job.StatusDate);
  const startDate = parseBigChangeDate(options.start);
  const endDate = parseBigChangeDate(options.end);
  if (!statusDate || !startDate || !endDate) {
    return false;
  }
  return statusDate >= startDate && statusDate <= endDate;
}

async function listCandidateJobs(client, options) {
  const allRows = [];
  for (let page = 0; ; page += 1) {
    const response = await client.call("Jobslist", {
      Actioned: 1,
      Allocated: 1,
      End: options.end,
      IncludeExtra: 1,
      Page: page,
      PageSize: options.pageSize,
      Start: options.queryStart,
      Statusid: "12|13",
      Unactioned: 1,
      Unallocated: 1,
      includetime: 1,
    });

    const rows = Array.isArray(response.Result) ? response.Result : [];
    allRows.push(...rows);
    if (rows.length < options.pageSize) {
      break;
    }
  }

  return allRows
    .filter(isCompletedStatus)
    .filter(isUnactioned)
    .filter(isNotAlreadyFlaggedActioned)
    .filter((job) => resultIsPlainComplete(job.StatusComment))
    .filter((job) => isCompletedWithinWindow(job, options))
    .sort((left, right) => String(left.Ref).localeCompare(String(right.Ref)));
}

async function applyActionedTag(client, job, options) {
  const response = await client.call("SetJobTag", {
    Comment: "Marked with Actioned tag by Cursor automation",
    JobId: job.JobId,
    Notifications: 0,
    TagId: options.tagId,
  });
  if (response.Code !== 0) {
    throw new Error(`SetJobTag failed for ${job.Ref}: ${JSON.stringify(response)}`);
  }
}

function printJob(job) {
  console.log(
    [
      job.Ref,
      `JobId=${job.JobId}`,
      `Status=${job.Status}`,
      `Result=${job.StatusComment}`,
      `StatusDate=${job.StatusDate}`,
      `CurrentFlag=${job.CurrentFlag || ""}`,
      `Type=${job.Type}`,
    ].join(" | "),
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    loadDotEnv();

    const client = new BigChangeClient(configFromEnv());
    const candidates = await listCandidateJobs(client, options);

    console.log(
      `${options.execute ? "Executing" : "Dry run"} for completed jobs from ` +
        `${options.start} to ${options.end}.`,
    );
    console.log(`Actioned tag ID: ${options.tagId}`);
    console.log(`Candidate jobs: ${candidates.length}`);

    for (const job of candidates) {
      printJob(job);
    }

    if (!options.execute) {
      console.log("No changes made. Re-run with --execute to apply the Actioned flag.");
      return 0;
    }

    let updated = 0;
    for (const job of candidates) {
      await applyActionedTag(client, job, options);
      updated += 1;
      console.log(`Tagged ${job.Ref} (${job.JobId}) as Actioned`);
    }

    console.log(`Updated jobs: ${updated}`);
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Bulk actioned tagging failed: ${error.stack || error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
