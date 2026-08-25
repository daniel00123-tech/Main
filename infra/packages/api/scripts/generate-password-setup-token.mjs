#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, "..");

function parseArgs(argv) {
  const args = { email: "", remote: true, frontendBase: "https://infra-web.pages.dev" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--email") args.email = argv[++i] ?? "";
    else if (argv[i] === "--local") args.remote = false;
    else if (argv[i] === "--frontend") args.frontendBase = argv[++i] ?? args.frontendBase;
  }
  if (!args.email) {
    console.error("Usage: node scripts/generate-password-setup-token.mjs --email user@example.com");
    process.exit(1);
  }
  return args;
}

function d1Execute(sql, remote) {
  const flag = remote ? "--remote" : "--local";
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", flag, "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(output);
}

function d1ExecuteFile(file, remote) {
  const flag = remote ? "--remote" : "--local";
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", flag, "--file", file],
    { cwd: apiDir, stdio: "inherit" },
  );
}

function escapeSql(value) {
  return value.replace(/'/g, "''");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

const args = parseArgs(process.argv);
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const createdAt = new Date().toISOString();
const tokenId = newId("pst");

const userResult = d1Execute(
  `SELECT id FROM users WHERE email = '${escapeSql(args.email.toLowerCase())}' COLLATE NOCASE LIMIT 1;`,
  args.remote,
);
const userId = userResult?.[0]?.results?.[0]?.id;
if (!userId) {
  console.error(`No user found for email: ${args.email}`);
  process.exit(1);
}

const sqlFile = join(apiDir, ".tmp-setup-token.sql");
const sql = `
UPDATE password_setup_tokens SET used_at = '${createdAt}' WHERE user_id = '${escapeSql(userId)}' AND used_at IS NULL;
INSERT INTO password_setup_tokens (id, user_id, token_hash, purpose, expires_at, used_at, created_at)
VALUES ('${escapeSql(tokenId)}', '${escapeSql(userId)}', '${tokenHash}', 'password_setup', '${expiresAt}', NULL, '${createdAt}');
`;
writeFileSync(sqlFile, sql);

try {
  d1ExecuteFile(sqlFile, args.remote);
} finally {
  try {
    unlinkSync(sqlFile);
  } catch {
    // ignore
  }
}

const setupUrl = `${args.frontendBase.replace(/\/$/, "")}/setup-password?token=${encodeURIComponent(token)}`;
console.log("Password setup URL (single-use, expires in 1 hour):");
console.log(setupUrl);
console.log(`Account: ${args.email}`);
console.log(`Expires: ${expiresAt}`);
