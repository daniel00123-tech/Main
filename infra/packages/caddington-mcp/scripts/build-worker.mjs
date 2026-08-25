import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const basePath = path.join(pkgRoot, "vendor/base.worker.js");
const distDir = path.join(pkgRoot, "dist");
const xeroBundlePath = path.join(distDir, "xero-inject.js");
const outPath = path.join(distDir, "worker.js");

if (!fs.existsSync(basePath)) {
  console.error("Missing vendor/base.worker.js — run npm run download-base first");
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(pkgRoot, "src/xero/inject-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: xeroBundlePath,
  alias: {
    "@infra/shared": path.join(pkgRoot, "../shared/src/index.ts"),
    "@infra/xero-core": path.join(pkgRoot, "../xero-core/src/index.ts"),
  },
  external: [],
  logLevel: "info",
});

const xeroBundle = fs.readFileSync(xeroBundlePath, "utf8");
let base = fs.readFileSync(basePath, "utf8");

const injectCall =
  "  registerXeroReadTools(server, env2, external_exports);\n  registerXeroWriteTools(server, env2, external_exports);\n  return server;\n}\n__name(createCaddingtonMcpServer";
const fetchPatchTarget =
  "      const handler = createStatelessMcpHandler(\n        () => createCaddingtonMcpServer(env2),\n        { route: \"/mcp\", legacy: \"stateless\" }\n      );\n      return handler(request, env2, ctx);";
const fetchPatchReplacement = `      const xeroContextHeader = request.headers.get("X-Infra-Xero-Context");
      if (xeroContextHeader) {
        try {
          env2.__infraXeroContext = JSON.parse(atob(xeroContextHeader));
        } catch {
          // ignore malformed internal execution context
        }
      }
      const handler = createStatelessMcpHandler(
        () => createCaddingtonMcpServer(env2),
        { route: "/mcp", legacy: "stateless" }
      );
      return handler(request, env2, ctx);`;
if (!base.includes("registerXeroReadTools(server, env2")) {
  const target = "  return server;\n}\n__name(createCaddingtonMcpServer";
  if (!base.includes(target)) {
    throw new Error("Unable to locate createCaddingtonMcpServer injection point in base worker");
  }
  base = base.replace(target, injectCall);
}

if (!base.includes('request.headers.get("X-Infra-Xero-Context")')) {
  if (!base.includes(fetchPatchTarget)) {
    throw new Error("Unable to locate MCP fetch handler injection point in base worker");
  }
  base = base.replace(fetchPatchTarget, fetchPatchReplacement);
}

const inlinedXero = xeroBundle
  .replace(/\bexport\s+\{\s*registerXeroReadTools\s+as\s+__registerXeroReadTools\s*\};?\s*/g, "")
  .replace(/\bexport\s+\{\s*registerXeroWriteTools\s+as\s+__registerXeroWriteTools\s*\};?\s*/g, "")
  .replace(/\bfunction registerXeroReadTools\b/g, "function __registerXeroReadTools")
  .replace(/\bfunction registerXeroWriteTools\b/g, "function __registerXeroWriteTools");

const patched = `${base}\n${inlinedXero}\nfunction registerXeroReadTools(server, env2, external_exports) {\n  return __registerXeroReadTools(server, env2, external_exports);\n}\n__name(registerXeroReadTools, "registerXeroReadTools");\nfunction registerXeroWriteTools(server, env2, external_exports) {\n  return __registerXeroWriteTools(server, env2, external_exports);\n}\n__name(registerXeroWriteTools, "registerXeroWriteTools");\n`;

fs.writeFileSync(outPath, patched);
console.log(`Built ${outPath} (${patched.length} bytes)`);
