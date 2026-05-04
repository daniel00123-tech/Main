#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  BigChangeClient,
  BigChangeConfigError,
  configFromEnv,
  loadDotEnv,
} = require("./bigchangeClient");

function parseArgs(argv) {
  const options = {
    afOnly: false,
    end: formatDateTime(new Date()),
    limit: 25,
    output: path.join("reports", "job-verification.html"),
    start: formatDateTime(daysAgo(90)),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const [token, inlineValue] = splitArg(argv[index]);
    const value = inlineValue ?? argv[index + 1];

    if (token === "--af-only") {
      options.afOnly = true;
    } else if (token === "--start") {
      options.start = requireValue(token, value);
      index += inlineValue === undefined ? 1 : 0;
    } else if (token === "--end") {
      options.end = requireValue(token, value);
      index += inlineValue === undefined ? 1 : 0;
    } else if (token === "--limit") {
      options.limit = Number(requireValue(token, value));
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      index += inlineValue === undefined ? 1 : 0;
    } else if (token === "--output") {
      options.output = requireValue(token, value);
      index += inlineValue === undefined ? 1 : 0;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function splitArg(rawArg) {
  const separatorIndex = rawArg.indexOf("=");
  if (separatorIndex === -1) {
    return [rawArg, undefined];
  }
  return [rawArg.slice(0, separatorIndex), rawArg.slice(separatorIndex + 1)];
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

function buildRows(records, options) {
  const filtered = options.afOnly
    ? records.filter((job) => /^AF/i.test(String(job.Ref || "")))
    : records;

  return filtered.slice(0, options.limit).map((job) => ({
    contact: job.Contact,
    created: job.Created,
    jobId: job.JobId,
    jobPo: job.JobPO,
    location: job.Location,
    plannedStart: job.PlannedStart,
    postcode: job.Postcode,
    ref: job.Ref,
    status: job.Status,
    type: job.Type,
  }));
}

function renderHtml(rows, options, totalRecords) {
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const title = "BigChange Job Verification Report";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --accent: #1f6feb;
      --border: #d0d7de;
      --muted: #57606a;
      --surface: #f6f8fa;
    }
    body {
      font-family: Arial, sans-serif;
      line-height: 1.45;
      margin: 0;
      padding: 24px;
    }
    header {
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
      padding-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
    }
    .summary {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin: 18px 0;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .label {
      color: var(--muted);
      display: block;
      font-size: 12px;
      text-transform: uppercase;
    }
    .value {
      display: block;
      font-size: 18px;
      font-weight: bold;
      margin-top: 4px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--surface);
      position: sticky;
      top: 0;
    }
    .job-ref {
      color: var(--accent);
      font-weight: bold;
      white-space: nowrap;
    }
    .muted {
      color: var(--muted);
    }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <p class="muted">Read-only BigChange API verification report generated locally in Cursor.</p>
  </header>

  <section class="summary">
    <div class="card">
      <span class="label">Date range</span>
      <span class="value">${escapeHtml(options.start)} to ${escapeHtml(options.end)}</span>
    </div>
    <div class="card">
      <span class="label">Returned by API</span>
      <span class="value">${totalRecords}</span>
    </div>
    <div class="card">
      <span class="label">Displayed rows</span>
      <span class="value">${rows.length}</span>
    </div>
    <div class="card">
      <span class="label">Filter</span>
      <span class="value">${options.afOnly ? "AF references only" : "All references"}</span>
    </div>
    <div class="card">
      <span class="label">Generated at UTC</span>
      <span class="value">${generatedAt}</span>
    </div>
  </section>

  <table>
    <thead>
      <tr>
        <th>JobId</th>
        <th>Job reference</th>
        <th>PO</th>
        <th>Status</th>
        <th>Type</th>
        <th>Planned start</th>
        <th>Contact</th>
        <th>Location</th>
        <th>Postcode</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(renderRow).join("\n")}
    </tbody>
  </table>
</body>
</html>
`;
}

function renderRow(row) {
  return `<tr>
        <td>${escapeHtml(row.jobId)}</td>
        <td class="job-ref">${escapeHtml(row.ref)}</td>
        <td>${escapeHtml(row.jobPo)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.type)}</td>
        <td>${escapeHtml(row.plannedStart)}</td>
        <td>${escapeHtml(row.contact)}</td>
        <td>${escapeHtml(row.location)}</td>
        <td>${escapeHtml(row.postcode)}</td>
      </tr>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    const rows = buildRows(records, options);
    const html = renderHtml(rows, options, records.length);

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, html, "utf8");

    console.log(`Wrote ${rows.length} job rows to ${options.output}`);
    if (rows.length > 0) {
      console.log("First rows:");
      for (const row of rows.slice(0, 10)) {
        console.log(`${row.jobId} -> ${row.ref || "(no ref)"}`);
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof BigChangeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      console.error("Create a .env file using .env.example as a template.");
      return 2;
    }

    console.error(`Report generation failed: ${error.message}`);
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
