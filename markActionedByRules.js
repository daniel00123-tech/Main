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
  const options = {
    end: "2026-04-30 23:59:59",
    execute: false,
    pageSize: DEFAULT_PAGE_SIZE,
    queryStart: "2026-01-01 00:00:00",
    start: "2026-04-15 00:00:00",
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

function parseBigChangeDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${String(value).replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function inWindow(value, options) {
  const date = parseBigChangeDate(value);
  const start = parseBigChangeDate(options.start);
  const end = parseBigChangeDate(options.end);
  return Boolean(date && start && end && date >= start && date <= end);
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

function isPlainCompletedResult(value) {
  const normalised = String(value ?? "").trim().toLowerCase();
  return normalised === "complete" || normalised === "completed";
}

function isQuoteRequiredResult(value) {
  return /quote required/i.test(String(value ?? ""));
}

function isFollowUpRequiredResult(value) {
  return /(no access|further time needed|additional time required|continuing job tomorrow)/i.test(
    String(value ?? ""),
  );
}

function isNotAlreadyActionedFlag(job) {
  return String(job.CurrentFlag ?? "").trim().toLowerCase() !== "actioned";
}

async function listCompletedJobs(client, options) {
  const jobs = [];
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
    jobs.push(...rows);
    if (rows.length < options.pageSize) {
      break;
    }
  }

  return jobs.filter(isCompletedStatus).filter((job) => inWindow(job.StatusDate, options));
}

async function getJobQuoteEvidence(client, job) {
  const activityResponse = await client.call("JobCustomerActivity", { jobId: job.JobId });
  const activity = Array.isArray(activityResponse.Result) ? activityResponse.Result : [];
  const quoteSent = activity.find((event) => event.JobClientStatus === "QuoteSent");
  if (quoteSent) {
    return {
      evidence: "QuoteSent activity",
      quoteRef: extractReference(quoteSent.JobClientStatusComment),
      sentDate: quoteSent.JobClientStatusDate,
    };
  }

  const docResponse = await client.call("FinancialDoc", {
    includeAllDocTypes: 1,
    jobId: job.JobId,
  });
  const docs = normaliseFinancialDocs(docResponse.Result);
  const sentQuote = docs.find(
    (doc) =>
      doc.DocumentType === "Quote" &&
      doc.SentDate &&
      !doc.CancellationDate &&
      !doc.DeletionDate &&
      !doc.RejectionDate,
  );

  return sentQuote
    ? {
        evidence: "FinancialDoc SentDate",
        quoteRef: sentQuote.Reference,
        sentDate: sentQuote.SentDate,
      }
    : null;
}

function normaliseFinancialDocs(result) {
  if (!result) {
    return [];
  }
  if (Array.isArray(result)) {
    return result;
  }
  if (result.DocumentType) {
    return [result];
  }
  if (typeof result === "object") {
    return Object.values(result)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value) => value && typeof value === "object" && value.DocumentType);
  }
  return [];
}

function extractReference(comment) {
  const match = String(comment || "").match(/Reference\s+(.+)/i);
  return match ? match[1].trim() : "";
}

function findLaterGroupJob(job, jobsByGroup) {
  if (!job.JobGroupId) {
    return null;
  }
  const baseDate =
    parseBigChangeDate(job.StatusDate) ||
    parseBigChangeDate(job.RealEnd) ||
    parseBigChangeDate(job.PlannedEnd) ||
    parseBigChangeDate(job.PlannedStart);
  if (!baseDate) {
    return null;
  }

  return (jobsByGroup.get(job.JobGroupId) || [])
    .filter((candidate) => candidate.JobId !== job.JobId)
    .find((candidate) => {
      const candidateDate =
        parseBigChangeDate(candidate.PlannedStart) ||
        parseBigChangeDate(candidate.StatusDate) ||
        parseBigChangeDate(candidate.Created);
      return candidateDate && candidateDate > baseDate;
    });
}

async function buildRuleMatches(client, jobs) {
  const jobsByGroup = new Map();
  for (const job of jobs.filter((item) => item.JobGroupId)) {
    const groupJobs = jobsByGroup.get(job.JobGroupId) || [];
    groupJobs.push(job);
    jobsByGroup.set(job.JobGroupId, groupJobs);
  }

  const matches = [];
  for (const job of jobs.filter(isNotAlreadyActionedFlag)) {
    if (isPlainCompletedResult(job.StatusComment)) {
      matches.push({
        job,
        reason: "plain-completed",
      });
      continue;
    }

    if (isQuoteRequiredResult(job.StatusComment)) {
      const quoteEvidence = await getJobQuoteEvidence(client, job);
      if (quoteEvidence) {
        matches.push({
          job,
          quoteEvidence,
          reason: "quote-required-sent",
        });
      }
      continue;
    }

    if (isFollowUpRequiredResult(job.StatusComment)) {
      const laterJob = findLaterGroupJob(job, jobsByGroup);
      if (laterJob) {
        matches.push({
          job,
          laterJob,
          reason: "follow-up-in-group",
        });
      }
    }
  }
  return matches;
}

async function applyActionedFlag(client, match, options) {
  const response = await client.call("SetJobTag", {
    Comment: `Marked Actioned by Cursor automation rule: ${match.reason}`,
    JobId: match.job.JobId,
    Notifications: 0,
    TagId: options.tagId,
  });
  if (response.Code !== 0) {
    throw new Error(`SetJobTag failed for ${match.job.Ref}: ${JSON.stringify(response)}`);
  }
}

function printMatch(match) {
  const details = [
    match.job.Ref,
    `JobId=${match.job.JobId}`,
    `Rule=${match.reason}`,
    `Status=${match.job.Status}`,
    `Result=${match.job.StatusComment}`,
    `StatusDate=${match.job.StatusDate}`,
    `CurrentFlag=${match.job.CurrentFlag || ""}`,
  ];

  if (match.quoteEvidence) {
    details.push(
      `Quote=${match.quoteEvidence.quoteRef || ""}`,
      `QuoteSent=${match.quoteEvidence.sentDate}`,
    );
  }
  if (match.laterJob) {
    details.push(
      `LaterJob=${match.laterJob.Ref}`,
      `LaterPlannedStart=${match.laterJob.PlannedStart || ""}`,
    );
  }

  console.log(details.join(" | "));
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    loadDotEnv();

    const client = new BigChangeClient(configFromEnv());
    const jobs = await listCompletedJobs(client, options);
    const matches = await buildRuleMatches(client, jobs);

    console.log(
      `${options.execute ? "Executing" : "Dry run"} actioning rules from ` +
        `${options.start} to ${options.end}.`,
    );
    console.log(`Completed/completed-with-issues jobs in window: ${jobs.length}`);
    console.log(`Matches: ${matches.length}`);
    for (const match of matches) {
      printMatch(match);
    }

    if (!options.execute) {
      console.log("No changes made. Re-run with --execute to apply the Actioned flag.");
      return 0;
    }

    let updated = 0;
    for (const match of matches) {
      await applyActionedFlag(client, match, options);
      updated += 1;
      console.log(`Tagged ${match.job.Ref} (${match.job.JobId}) as Actioned`);
    }

    console.log(`Updated jobs: ${updated}`);
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Actioning rules failed: ${error.stack || error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
