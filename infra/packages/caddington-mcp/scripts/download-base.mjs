import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const vendorDir = path.join(pkgRoot, "vendor");
const outPath = path.join(vendorDir, "base.worker.js");

fs.mkdirSync(vendorDir, { recursive: true });

const accountId = execSync("npx wrangler whoami 2>/dev/null | rg -o '[0-9a-f]{32}' | head -1", {
  cwd: pkgRoot,
  encoding: "utf8",
}).trim();

if (!accountId) {
  throw new Error("Unable to resolve Cloudflare account id via wrangler whoami");
}

execSync(
  `curl -sS "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/caddington-mcp" ` +
    `-H "Authorization: Bearer ${process.env.CLOUDFLARE_API_TOKEN}" -o "${outPath}.raw"`,
  { stdio: "inherit" },
);

let raw = fs.readFileSync(`${outPath}.raw`, "utf8");
if (raw.startsWith("--")) {
  const marker = raw.indexOf("var __defProp");
  if (marker >= 0) raw = raw.slice(marker);
  raw = raw.replace(/\n--[0-9a-f]+--\s*$/i, "");
}
fs.writeFileSync(outPath, raw);
fs.unlinkSync(`${outPath}.raw`);
console.log(`Saved cleaned base worker to ${outPath} (${raw.length} bytes)`);
