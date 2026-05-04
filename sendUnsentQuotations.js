#!/usr/bin/env node
"use strict";

const {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  loadDotEnv,
} = require("./bigchangeClient");

const ACTIONED_TAG_ID = 314031;

function parseArgs(argv) {
  const options = {
    end: formatDateTime(new Date()),
    execute: false,
    limit: 10,
    start: formatDateTime(daysAgo(30)),
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
    } else if (name === "--limit") {
      options.limit = parsePositiveInteger(name, nextValue);
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

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function formatDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function isUnsentQuote(doc) {
  return (
    doc &&
    doc.DocumentType === "Quote" &&
    !doc.SentDate &&
    !doc.AcceptedDate &&
    !doc.RejectionDate &&
    !doc.CancellationDate &&
    !doc.DeletionDate
  );
}

function pickMainPerson(people) {
  if (!Array.isArray(people)) {
    return null;
  }
  return (
    people.find(
      (person) =>
        String(person.isMainUser || "").toLowerCase() === "yes" && person.Email,
    ) ||
    people.find((person) => person.Email) ||
    null
  );
}

function splitName(name) {
  const parts = String(name || "Main Contact").trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1),
  };
}

async function getContactDetail(client, contactCache, contactId) {
  if (!contactId) {
    return null;
  }
  if (!contactCache.has(contactId)) {
    const response = await client.call("ContactDetail", { contactId });
    contactCache.set(contactId, response.Result || null);
  }
  return contactCache.get(contactId);
}

async function getContactPeople(client, peopleCache, contactId) {
  if (!contactId) {
    return [];
  }
  if (!peopleCache.has(contactId)) {
    const response = await client.call("ContactListPerson", {
      ContactId: contactId,
      DisplayMainUser: 1,
    });
    peopleCache.set(contactId, Array.isArray(response.Result) ? response.Result : []);
  }
  return peopleCache.get(contactId);
}

async function listCandidates(client, options) {
  const quotesResponse = await client.call("Quotations", {
    end: options.end,
    start: options.start,
  });
  const quotes = Array.isArray(quotesResponse.Result) ? quotesResponse.Result : [];
  const contactCache = new Map();
  const peopleCache = new Map();
  const candidates = [];

  for (const quote of quotes) {
    const docResponse = await client.call("FinancialDoc", {
      docRef: quote.Reference,
      includeAllDocTypes: 1,
    });
    const doc = docResponse.Result;
    if (!isUnsentQuote(doc)) {
      continue;
    }

    const site = await getContactDetail(client, contactCache, doc.ContactId);
    const parentId = site?.ParentId || doc.ContactId;
    const parent = await getContactDetail(client, contactCache, parentId);
    const parentPeople = await getContactPeople(client, peopleCache, parentId);
    const parentPrimary = pickMainPerson(parentPeople);
    const primaryEmail = parentPrimary?.Email || parent?.Email;

    if (!primaryEmail) {
      continue;
    }

    candidates.push({
      doc,
      parent,
      parentPrimary,
      primaryEmail,
      site,
    });

    if (candidates.length >= options.limit) {
      break;
    }
  }

  return { candidates, scanned: quotes.length };
}

async function ensureSiteContactPerson(client, candidate) {
  const sitePeople = await getContactPeople(client, new Map(), candidate.doc.ContactId);
  const existing = sitePeople.find(
    (person) =>
      String(person.Email || "").toLowerCase() ===
      String(candidate.primaryEmail).toLowerCase(),
  );
  const sourceName =
    candidate.parentPrimary?.Name ||
    candidate.parent?.Person ||
    candidate.parent?.Name ||
    "Main Contact";
  const { firstName, lastName } = splitName(sourceName);

  if (existing && String(existing.isMainUser || "").toLowerCase() === "yes") {
    return { action: "already-present", personId: existing.Id };
  }

  const params = {
    ContactId: candidate.doc.ContactId,
    Email: candidate.primaryEmail,
    FirstName: firstName,
    LastName: lastName,
    MainUser: 1,
  };

  if (existing?.Id) {
    params.UserId = existing.Id;
  }

  const response = await client.call("ContactSavePerson", params);
  if (response.Code !== 0) {
    throw new Error(
      `ContactSavePerson failed for ${candidate.doc.Reference}: ${JSON.stringify(
        response,
      )}`,
    );
  }

  return {
    action: existing ? "updated-main-user" : "created",
    personId: response.Result || existing?.Id,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function quoteHasSentEvidence(client, candidate) {
  const docResponse = await client.call("FinancialDoc", {
    docRef: candidate.doc.Reference,
    includeAllDocTypes: 1,
  });
  const latestDoc = docResponse.Result;
  if (latestDoc?.SentDate) {
    return { evidence: "SentDate", latestDoc };
  }

  if (!candidate.doc.JobId) {
    return { evidence: null, latestDoc };
  }

  const activityResponse = await client.call("JobCustomerActivity", {
    jobId: candidate.doc.JobId,
  });
  const activity = Array.isArray(activityResponse.Result)
    ? activityResponse.Result
    : [];
  const quoteSent = activity.find(
    (event) =>
      event.JobClientStatus === "QuoteSent" &&
      String(event.JobClientStatusComment || "").includes(candidate.doc.Reference),
  );

  return {
    evidence: quoteSent ? "QuoteSent activity" : null,
    latestDoc,
    quoteSent,
  };
}

async function sendQuote(client, candidate) {
  const sendResponse = await client.call("FinancialDocSend", {
    docId: candidate.doc.DocId,
    returnType: 1,
  });
  if (sendResponse.Code !== 0) {
    throw new Error(
      `FinancialDocSend failed for ${candidate.doc.Reference}: ${JSON.stringify(
        sendResponse,
      )}`,
    );
  }

  await wait(3000);
  const sentEvidence = await quoteHasSentEvidence(client, candidate);
  if (!sentEvidence.evidence) {
    throw new Error(
      `FinancialDocSend returned success for ${candidate.doc.Reference}, ` +
        "but BigChange did not create SentDate or QuoteSent activity. " +
        "The job will not be flagged Actioned.",
    );
  }

  return sentEvidence.evidence;
}

async function tagLinkedJob(client, candidate, options) {
  if (!candidate.doc.JobId) {
    return "skipped-no-job";
  }

  const response = await client.call("SetJobTag", {
    Comment: `Marked with Actioned tag after quote ${candidate.doc.Reference} was sent by Cursor automation`,
    JobId: candidate.doc.JobId,
    Notifications: 0,
    TagId: options.tagId,
  });
  if (response.Code !== 0) {
    throw new Error(
      `SetJobTag failed for ${candidate.doc.JobReference}: ${JSON.stringify(
        response,
      )}`,
    );
  }
  return "tagged";
}

function printCandidate(candidate) {
  console.log(
    [
      `Quote=${candidate.doc.Reference}`,
      `DocId=${candidate.doc.DocId}`,
      `Job=${candidate.doc.JobReference || ""}`,
      `Created=${candidate.doc.CreatedDate}`,
      `Total=${candidate.doc.Totals?.TotalInclTax ?? ""}`,
      `Site=${candidate.doc.ContactName}`,
      `Parent=${candidate.parent?.Name || ""}`,
      `Email=${candidate.primaryEmail}`,
    ].join(" | "),
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    loadDotEnv();

    const client = new BigChangeClient(configFromEnv());
    const { candidates, scanned } = await listCandidates(client, options);

    console.log(
      `${options.execute ? "Executing" : "Dry run"} quote send workflow from ` +
        `${options.start} to ${options.end}.`,
    );
    console.log(`Quotation rows scanned: ${scanned}`);
    console.log(`Candidates: ${candidates.length}`);
    for (const candidate of candidates) {
      printCandidate(candidate);
    }

    if (!options.execute) {
      console.log("No changes made. Re-run with --execute to send quotes.");
      return 0;
    }

    let sent = 0;
    let tagged = 0;
    for (const candidate of candidates) {
      const contactPerson = await ensureSiteContactPerson(client, candidate);
      const sentEvidence = await sendQuote(client, candidate);
      const tagResult = await tagLinkedJob(client, candidate, options);

      sent += 1;
      tagged += tagResult === "tagged" ? 1 : 0;
      console.log(
        `Sent ${candidate.doc.Reference} (${sentEvidence}); ` +
          `site contact ${contactPerson.action}; job ${tagResult}`,
      );
    }

    console.log(`Quotes sent: ${sent}`);
    console.log(`Jobs flagged Actioned: ${tagged}`);
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Quote send workflow failed: ${error.stack || error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
