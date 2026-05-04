#!/usr/bin/env node
"use strict";

const {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  loadDotEnv,
} = require("./bigchangeClient");

function parseArgs(argv) {
  const now = new Date();
  const options = {
    end: `${now.getUTCFullYear()}-12-31 23:59:59`,
    limit: 10,
    start: `${now.getUTCFullYear()}-01-01 00:00:00`,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const [name, inlineValue] = splitOption(argv[index]);
    const nextValue = inlineValue ?? argv[index + 1];

    if (name === "--start") {
      options.start = requireValue(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else if (name === "--end") {
      options.end = requireValue(name, nextValue);
      index += inlineValue === undefined ? 1 : 0;
    } else if (name === "--limit") {
      options.limit = parsePositiveInteger(name, nextValue);
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

function isUnsentQuote(document) {
  return (
    document &&
    document.DocumentType === "Quote" &&
    !document.SentDate &&
    !document.AcceptedDate &&
    !document.RejectionDate &&
    !document.CancellationDate &&
    !document.DeletionDate
  );
}

function pickPrimaryPerson(people) {
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

async function getContactDetail(client, cache, contactId) {
  if (!contactId) {
    return null;
  }
  if (!cache.has(contactId)) {
    const response = await client.call("ContactDetail", { contactId });
    cache.set(contactId, response.Result || null);
  }
  return cache.get(contactId);
}

async function getContactPeople(client, cache, contactId) {
  if (!contactId) {
    return [];
  }
  if (!cache.has(contactId)) {
    const response = await client.call("ContactListPerson", {
      ContactId: contactId,
      DisplayMainUser: 1,
    });
    cache.set(contactId, Array.isArray(response.Result) ? response.Result : []);
  }
  return cache.get(contactId);
}

async function findUnsentQuotations(client, options) {
  const contactCache = new Map();
  const peopleCache = new Map();
  const quotationsResponse = await client.call("Quotations", {
    end: options.end,
    start: options.start,
  });
  const quotations = Array.isArray(quotationsResponse.Result)
    ? quotationsResponse.Result
    : [];
  const candidates = [];

  for (const quotation of quotations) {
    const documentResponse = await client.call("FinancialDoc", {
      docRef: quotation.Reference,
      includeAllDocTypes: 1,
    });
    const document = documentResponse.Result;
    if (!isUnsentQuote(document)) {
      continue;
    }

    const siteContact = await getContactDetail(
      client,
      contactCache,
      document.ContactId || quotation.ContactId,
    );
    const parentContactId =
      siteContact?.ParentId || document.ContactId || quotation.ContactId;
    const parentContact = await getContactDetail(
      client,
      contactCache,
      parentContactId,
    );
    const parentPeople = await getContactPeople(
      client,
      peopleCache,
      parentContactId,
    );
    const primaryPerson = pickPrimaryPerson(parentPeople);
    const primaryEmail = primaryPerson?.Email || parentContact?.Email;

    if (!primaryEmail) {
      continue;
    }

    candidates.push({
      created: document.CreatedDate,
      docId: document.DocId,
      docRef: document.Reference,
      jobId: document.JobId,
      jobRef: document.JobReference,
      jobType: document.JobType,
      parentContactId,
      parentEmail: parentContact?.Email || "",
      parentName: parentContact?.Name || "",
      primaryPersonEmail: primaryEmail,
      primaryPersonName: primaryPerson?.Name || parentContact?.Person || "",
      primaryPersonIsMainUser: primaryPerson?.isMainUser || "",
      siteContactId: document.ContactId,
      siteName: document.ContactName,
      totalInclTax: document.Totals?.TotalInclTax,
    });

    if (candidates.length >= options.limit) {
      break;
    }
  }

  return { candidates, scanned: quotations.length };
}

function printCandidate(candidate) {
  console.log(
    [
      `Quote=${candidate.docRef}`,
      `DocId=${candidate.docId}`,
      `Job=${candidate.jobRef}`,
      `Created=${candidate.created}`,
      `Total=${candidate.totalInclTax}`,
      `Site=${candidate.siteName}`,
      `Parent=${candidate.parentName}`,
      `Primary=${candidate.primaryPersonName} <${candidate.primaryPersonEmail}>`,
      `MainUser=${candidate.primaryPersonIsMainUser}`,
    ].join(" | "),
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    loadDotEnv();

    const client = new BigChangeClient(configFromEnv());
    const { candidates, scanned } = await findUnsentQuotations(client, options);

    console.log(`Quotation rows scanned: ${scanned}`);
    console.log(`Unsent/unaccepted candidates with parent email: ${candidates.length}`);
    for (const candidate of candidates) {
      printCandidate(candidate);
    }
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Unsent quotation discovery failed: ${error.stack || error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
