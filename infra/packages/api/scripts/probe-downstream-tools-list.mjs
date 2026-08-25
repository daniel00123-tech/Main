#!/usr/bin/env node
/** Probe downstream caddington-mcp tools/list via service-binding path metadata — never prints tokens. */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

// Downstream tool names from allowlist + action maps (what listMcpTools should return before INFRA filtering)
const allowlist = d1(
  "SELECT tool_name FROM mcp_tool_allowlist WHERE mcp_environment_id = 'mcp_caddington_primary' AND enabled = 1 ORDER BY tool_name",
);
const actionMaps = d1(
  "SELECT tool_name, action FROM mcp_tool_action_map WHERE mcp_environment_id = 'mcp_caddington_primary' ORDER BY tool_name",
);

const allowedNames = allowlist.map((r) => r.tool_name);
const xeroWriteTools = ["xero_create_draft_invoice"];

console.log(
  JSON.stringify(
    {
      note: "Direct downstream tools/list requires MCP auth; inferred from D1 allowlist + deployed worker registration",
      allowlistToolCount: allowedNames.length,
      allowlistToolNames: allowedNames,
      includesWriteToolInAllowlist: allowedNames.includes("xero_create_draft_invoice"),
      actionMapCount: actionMaps.length,
      writeToolsFilteredByInfra: xeroWriteTools,
    },
    null,
    2,
  ),
);
