/**
 * Generates Phase 2 dummy Heat Tech data (~1000 records) and writes batched SQL
 * for wrangler d1 execute. Run: node scripts/seed-phase2.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../seed-output");
const SOURCE = "phase2_dummy";

const FIRST_NAMES = [
  "Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry", "Ivy", "Jack",
  "Karen", "Liam", "Maya", "Noah", "Olivia", "Paul", "Quinn", "Rachel", "Sam", "Tina",
  "Uma", "Victor", "Wendy", "Xander", "Yasmin", "Zoe", "Aaron", "Beth", "Chris", "Diana",
];
const LAST_NAMES = [
  "Ashford", "Bennett", "Carter", "Davies", "Ellis", "Foster", "Green", "Harris", "Irving", "Jones",
  "Kemp", "Lewis", "Morgan", "Nelson", "Owen", "Patel", "Quinn", "Reed", "Scott", "Taylor",
  "Underwood", "Vaughan", "Walsh", "Young", "Zimmerman", "Brooks", "Clark", "Dixon", "Evans", "Ford",
];
const STREETS = [
  "Oak Lane", "Maple Close", "Cedar Road", "Birch Avenue", "Elm Street", "Willow Way",
  "Station Road", "Church Lane", "Millbrook Drive", "Hawthorn Court",
];
const POSTCODES = ["SW1A 1AA", "M1 2AB", "B33 8TH", "LS1 4DY", "EH1 1YZ", "CF10 1EP", "NE1 4ST", "L1 8JQ"];

const JOB_TYPES = ["service", "installation", "call_out", "maintenance", "boiler_repair", "gas_safety"];
const JOB_STATUSES = ["booked", "in_progress", "completed", "cancelled", "on_hold"];
const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"];

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function pickWeighted(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
function esc(s) {
  return String(s).replace(/'/g, "''");
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function fmtDateTime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

const CUSTOMER_COUNT = 100;
const ENGINEER_COUNT = 20;
const JOB_COUNT = 450;
const QUOTE_COUNT = 200;
const INVOICE_TARGET = 350;
const PAYMENT_TARGET = 320;

const startDate = new Date("2024-01-01T08:00:00Z");
const endDate = new Date("2025-08-01T17:00:00Z");

function randomDateBetween(start, end) {
  const t = start.getTime() + rand() * (end.getTime() - start.getTime());
  return new Date(t);
}

const lines = [`-- Phase 2 dummy seed generated ${new Date().toISOString()}`];

lines.push(
  `INSERT INTO import_log (source_system, import_type, status, started_at, completed_at, records_processed, metadata) VALUES ('${SOURCE}', 'full', 'started', datetime('now'), NULL, 0, '{"phase":"2","label":"Heat Tech dummy dataset"}');`
);

const customerInserts = [];
for (let i = 1; i <= CUSTOMER_COUNT; i++) {
  const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  const accountType = rand() < 0.25 ? "commercial" : "residential";
  const postcode = pick(POSTCODES);
  customerInserts.push(
    `INSERT INTO customers (external_id, source_system, name, account_type, postcode, import_batch_id) VALUES ('CUST-${String(i).padStart(5, "0")}', '${SOURCE}', '${esc(name)}', '${accountType}', '${postcode}', (SELECT MAX(id) FROM import_log WHERE source_system='${SOURCE}' AND status='started'));`
  );
}

const engineerInserts = [];
const engineerNames = [
  "James Thornton", "Sarah Mitchell", "Oliver Hughes", "Emily Clarke", "Daniel Brooks",
  "Sophie Turner", "Michael Walsh", "Laura Bennett", "Thomas Reed", "Hannah Cooper",
  "Robert Ellis", "Charlotte Price", "William Grant", "Jessica Moore", "Andrew Parker",
  "Rebecca Shaw", "Christopher Lane", "Nicole Adams", "Matthew Ford", "Amanda Kelly",
];
for (let i = 1; i <= ENGINEER_COUNT; i++) {
  engineerInserts.push(
    `INSERT INTO engineers (external_id, source_system, name, active, import_batch_id) VALUES ('ENG-${String(i).padStart(3, "0")}', '${SOURCE}', '${esc(engineerNames[i - 1])}', 1, (SELECT MAX(id) FROM import_log WHERE source_system='${SOURCE}' AND status='started'));`
  );
}

const jobInserts = [];
const jobsMeta = [];
for (let i = 1; i <= JOB_COUNT; i++) {
  const customerIdx = 1 + Math.floor(rand() * CUSTOMER_COUNT);
  const engineerIdx = 1 + Math.floor(rand() * ENGINEER_COUNT);
  const jobType = pickWeighted(
    JOB_TYPES,
  [0.22, 0.18, 0.12, 0.15, 0.18, 0.05]
  );
  const status = pickWeighted(
    JOB_STATUSES,
    [0.08, 0.07, 0.72, 0.05, 0.08]
  );
  const isCallOut = jobType === "call_out" ? 1 : rand() < 0.03 ? 1 : 0;

  const scheduled = randomDateBetween(startDate, endDate);
  const durationHours = jobType === "installation" ? 4 + rand() * 6 : 1 + rand() * 3;
  const scheduledEnd = new Date(scheduled.getTime() + durationHours * 3600000);

  let actualStart = null;
  let actualEnd = null;
  let completionDate = null;
  if (status === "completed") {
    actualStart = new Date(scheduled.getTime() + rand() * 3600000);
    actualEnd = new Date(actualStart.getTime() + durationHours * 3600000);
    completionDate = fmtDate(actualEnd);
  }

  let baseCharge =
    jobType === "installation"
      ? 1200 + rand() * 2800
      : jobType === "call_out"
        ? 180 + rand() * 320
        : 85 + rand() * 400;

  if (status === "cancelled") baseCharge *= 0.3;

  const engineerCost = round2(baseCharge * (0.18 + rand() * 0.12));
  const materialsCost = round2(baseCharge * (0.08 + rand() * 0.22));
  let grossProfit = round2(baseCharge - engineerCost - materialsCost);
  let marginPct =
    baseCharge > 0 ? round2((grossProfit / baseCharge) * 100) : 0;

  // Inject some low-margin jobs
  if (rand() < 0.12 && status === "completed") {
    marginPct = round2(15 + rand() * 14);
    grossProfit = round2((baseCharge * marginPct) / 100);
  }

  const externalId = `JOB-${String(i).padStart(5, "0")}`;
  jobInserts.push(
    `INSERT INTO jobs (external_id, source_system, customer_id, engineer_id, job_type_code, status_code, scheduled_start, scheduled_end, actual_start, actual_end, completion_date, is_call_out, customer_charge, engineer_cost, materials_cost, gross_profit, gross_margin_pct, import_batch_id) VALUES ('${externalId}', '${SOURCE}', ${customerIdx}, ${engineerIdx}, '${jobType}', '${status}', '${fmtDateTime(scheduled)}', '${fmtDateTime(scheduledEnd)}', ${actualStart ? `'${fmtDateTime(actualStart)}'` : "NULL"}, ${actualEnd ? `'${fmtDateTime(actualEnd)}'` : "NULL"}, ${completionDate ? `'${completionDate}'` : "NULL"}, ${isCallOut}, ${round2(baseCharge)}, ${engineerCost}, ${materialsCost}, ${grossProfit}, ${marginPct}, (SELECT MAX(id) FROM import_log WHERE source_system='${SOURCE}' AND status='started'));`
  );
  jobsMeta.push({
    idx: i,
    externalId,
    customerIdx,
    status,
    charge: round2(baseCharge),
    completionDate,
    grossProfit,
    marginPct,
  });
}

const quoteInserts = [];
const quotesMeta = [];
for (let i = 1; i <= QUOTE_COUNT; i++) {
  const customerIdx = 1 + Math.floor(rand() * CUSTOMER_COUNT);
  const status = pickWeighted(QUOTE_STATUSES, [0.05, 0.35, 0.25, 0.2, 0.15]);
  const sentDate = randomDateBetween(startDate, endDate);
  const quoteValue = round2(150 + rand() * 3500);
  const converted = status === "accepted" && rand() < 0.85 ? 1 : 0;
  const externalId = `QUO-${String(i).padStart(5, "0")}`;
  quoteInserts.push(
    `INSERT INTO quotes (external_id, source_system, customer_id, status_code, quote_value, sent_date, converted, import_batch_id) VALUES ('${externalId}', '${SOURCE}', ${customerIdx}, '${status}', ${quoteValue}, '${fmtDate(sentDate)}', ${converted}, (SELECT MAX(id) FROM import_log WHERE source_system='${SOURCE}' AND status='started'));`
  );
  quotesMeta.push({ idx: i, externalId, customerIdx, converted, quoteValue, status });
}

// Link some converted quotes to completed jobs
const completedJobs = jobsMeta.filter((j) => j.status === "completed");
let linkIdx = 0;
for (const q of quotesMeta.filter((q) => q.converted === 1)) {
  if (linkIdx >= completedJobs.length) break;
  const job = completedJobs[linkIdx++];
  quoteInserts.push(
    `UPDATE quotes SET converted_job_id = (SELECT id FROM jobs WHERE external_id='${job.externalId}' AND source_system='${SOURCE}') WHERE external_id='${q.externalId}' AND source_system='${SOURCE}';`
  );
}

const invoiceInserts = [];
const invoicesMeta = [];
let invNum = 1000;
for (const job of completedJobs.slice(0, INVOICE_TARGET)) {
  invNum++;
  const invoiceDate = job.completionDate ?? fmtDate(randomDateBetween(startDate, endDate));
  const amount = job.charge;
  const externalId = `INV-${String(invNum).padStart(6, "0")}`;
  invoiceInserts.push(
    `INSERT INTO invoices (external_id, source_system, customer_id, job_id, invoice_number, invoice_date, amount, import_batch_id) VALUES ('${externalId}', '${SOURCE}', ${job.customerIdx}, (SELECT id FROM jobs WHERE external_id='${job.externalId}' AND source_system='${SOURCE}'), 'HT-${invNum}', '${invoiceDate}', ${amount}, (SELECT MAX(id) FROM import_log WHERE source_system='${SOURCE}' AND status='started'));`
  );
  invoicesMeta.push({ externalId, customerIdx: job.customerIdx, amount, invoiceDate });
}

const paymentInserts = [];
for (let i = 0; i < PAYMENT_TARGET && i < invoicesMeta.length; i++) {
  const inv = invoicesMeta[i];
  const payDate = addDays(new Date(inv.invoiceDate), Math.floor(rand() * 21) + 1);
  const amount = inv.amount;
  const externalId = `PAY-${String(i + 1).padStart(5, "0")}`;
  paymentInserts.push(
    `INSERT INTO payments (external_id, source_system, invoice_id, customer_id, payment_date, amount, import_batch_id) VALUES ('${externalId}', '${SOURCE}', (SELECT id FROM invoices WHERE external_id='${inv.externalId}' AND source_system='${SOURCE}'), ${inv.customerIdx}, '${fmtDate(payDate)}', ${amount}, (SELECT MAX(id) FROM import_log WHERE source_system='${SOURCE}' AND status='started'));`
  );
}

const totalRecords =
  CUSTOMER_COUNT +
  ENGINEER_COUNT +
  JOB_COUNT +
  QUOTE_COUNT +
  invoiceInserts.length +
  paymentInserts.length;

lines.push(...customerInserts);
lines.push(...engineerInserts);
lines.push(...jobInserts);
lines.push(...quoteInserts);
lines.push(...invoiceInserts);
lines.push(...paymentInserts);

lines.push(
  `UPDATE import_log SET status='completed', completed_at=datetime('now'), records_processed=${totalRecords} WHERE source_system='${SOURCE}' AND status='started';`
);

mkdirSync(OUT_DIR, { recursive: true });

// Split into batches of ~80 statements for wrangler execute limits
const BATCH_SIZE = 80;
const allStatements = lines.filter((l) => l && !l.startsWith("--"));
const batches = [];
for (let i = 0; i < allStatements.length; i += BATCH_SIZE) {
  batches.push(allStatements.slice(i, i + BATCH_SIZE));
}

for (let b = 0; b < batches.length; b++) {
  const path = join(OUT_DIR, `seed-batch-${String(b + 1).padStart(3, "0")}.sql`);
  writeFileSync(path, batches[b].join("\n") + "\n", "utf8");
}

writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify({
    source: SOURCE,
    totalRecords,
    batches: batches.length,
    counts: {
      customers: CUSTOMER_COUNT,
      engineers: ENGINEER_COUNT,
      jobs: JOB_COUNT,
      quotes: QUOTE_COUNT,
      invoices: invoiceInserts.length,
      payments: paymentInserts.length,
    },
  }, null, 2)
);

console.log(`Generated ${totalRecords} records in ${batches.length} batch files -> ${OUT_DIR}`);
