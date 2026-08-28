#!/usr/bin/env node
/**
 * Guard for Xero probe/acceptance scripts.
 * Diagnostic/read scripts must not mutate production unless explicitly opted in.
 */

const WRITE_SCRIPT_MARKERS = ["write", "draft-invoice-e2e", "draft-invoice-dry-run"];

export function scriptBasename(argv = process.argv) {
  return (argv[1] ?? "").split(/[/\\]/).pop() ?? "";
}

export function isWriteScriptName(name = scriptBasename()) {
  return WRITE_SCRIPT_MARKERS.some((marker) => name.includes(marker));
}

export function assertProductionWriteAllowed(input = {}) {
  const {
    scriptName = scriptBasename(),
    allowEnv = "ALLOW_XERO_PRODUCTION_WRITE",
    executeEnv = "EXECUTE",
    argv = process.argv,
  } = input;

  const explicitFlag =
    process.env[allowEnv] === "true" ||
    process.env[executeEnv] === "true" ||
    argv.includes("--allow-production-write");

  if (!isWriteScriptName(scriptName)) {
    return { ok: true, classification: "read_only_script" };
  }

  if (!explicitFlag) {
    console.error(
      JSON.stringify(
        {
          error: "XERO_PRODUCTION_WRITE_BLOCKED",
          script: scriptName,
          message:
            "This script can mutate production Xero. Re-run with ALLOW_XERO_PRODUCTION_WRITE=true or --allow-production-write.",
          requiredEnv: [allowEnv, executeEnv],
          requiredFlag: "--allow-production-write",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.error(
    JSON.stringify(
      {
        warning: "XERO_PRODUCTION_WRITE_EXPLICITLY_ENABLED",
        script: scriptName,
        message: "Production Xero mutations may occur. Ensure this is intentional.",
      },
      null,
      2,
    ),
  );

  return { ok: true, classification: "write_script_explicit" };
}
