/**
 * Removes prior Xero injection artefacts from a downloaded or built worker bundle
 * so rebuilds are idempotent (no duplicate registerXero* symbols).
 */

export const XERO_INJECT_BEGIN = "// INFRA_XERO_INJECT_BEGIN";
export const XERO_INJECT_END = "// INFRA_XERO_INJECT_END";

const REGISTRATION_CALL_RE =
  /\n\s*registerXeroReadTools\(server,\s*env\w+,\s*external_exports\w*\);\s*\n\s*registerXeroWriteTools\(server,\s*env\w+,\s*external_exports\w*\);\s*\n/g;

const LEGACY_TAIL_RE =
  /\n(?:var __defProp2 = Object\.defineProperty;\s*\nvar __export =|\bvar XERO_ACTIONS = \[)/;

const MARKER_TAIL_RE = new RegExp(`\\n${escapeRegExp(XERO_INJECT_BEGIN)}[\\s\\S]*$`);

const TRAILING_EXPORT_RE =
  /\nexport\s*\{[\s\S]*?index_default as default[\s\S]*?\};?\s*(?:\/\*![\s\S]*?\*\/\s*)?(?:\/\/# sourceMappingURL[^\n]*\n?)?$/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findIndexDefaultEnd(source) {
  const start = source.indexOf("var index_default = {");
  if (start < 0) {
    throw new Error("Unable to locate var index_default export in base worker");
  }
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
      started = true;
    } else if (char === "}") {
      depth -= 1;
      if (started && depth === 0) {
        let end = i + 1;
        if (source[end] === ";") end += 1;
        return end;
      }
    }
  }
  throw new Error("Unable to find end of index_default block");
}

/**
 * @param {string} source
 * @returns {string}
 */
export function stripXeroInjection(source) {
  let base = source.replace(REGISTRATION_CALL_RE, "\n");

  const indexDefaultEnd = findIndexDefaultEnd(base);
  const head = base.slice(0, indexDefaultEnd);
  const tail = base.slice(indexDefaultEnd);

  if (MARKER_TAIL_RE.test(tail)) {
    base = head.trimEnd();
  } else if (LEGACY_TAIL_RE.test(tail)) {
    const legacyStart = tail.search(LEGACY_TAIL_RE);
    base = head.trimEnd();
    if (legacyStart > 0) {
      // Preserve any benign whitespace between index_default and legacy inject only when
      // legacy marker is not at position 0 (shouldn't happen).
    }
  } else {
    base = head.trimEnd() + tail.replace(TRAILING_EXPORT_RE, "");
  }

  return base.trimEnd();
}

/**
 * @param {string} source
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
export function assertNoDuplicateXeroSymbols(source) {
  const counts = {
    __registerXeroReadTools: (source.match(/\bfunction __registerXeroReadTools\b/g) ?? []).length,
    __registerXeroWriteTools: (source.match(/\bfunction __registerXeroWriteTools\b/g) ?? []).length,
    registerXeroReadTools: (source.match(/\bfunction registerXeroReadTools\b/g) ?? []).length,
    registerXeroWriteTools: (source.match(/\bfunction registerXeroWriteTools\b/g) ?? []).length,
    injectBegin: (source.match(new RegExp(escapeRegExp(XERO_INJECT_BEGIN), "g")) ?? []).length,
    injectEnd: (source.match(new RegExp(escapeRegExp(XERO_INJECT_END), "g")) ?? []).length,
  };

  const problems = [];
  for (const [name, count] of Object.entries(counts)) {
    const expected = name.startsWith("inject") ? 1 : 1;
    if (name.startsWith("inject")) {
      if (count !== 1) problems.push(`${name} expected 1, got ${count}`);
    } else if (count > 1) {
      problems.push(`${name} expected at most 1, got ${count}`);
    }
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }
  return { ok: true };
}
