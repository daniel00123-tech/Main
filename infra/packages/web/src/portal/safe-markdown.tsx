import type { ReactNode } from "react";

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "ul" | "ol"; items: MarkdownInline[][] }
  | { type: "code"; text: string }
  | { type: "table"; headers: MarkdownInline[][]; rows: MarkdownInline[][][] };

export type EmailSummaryRow = {
  time?: string | null;
  subject: string;
  from?: string | null;
};

export type PortalChatActivityStep = {
  key: string;
  label: string;
  detail: string;
  status: "running" | "done";
};

const LIST_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index] ?? "").map(parseMarkdownInline);
      index += 2;
      const rows: MarkdownInline[][][] = [];
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? "").map(parseMarkdownInline));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: MarkdownInline[][] = [];
      while (index < lines.length && LIST_RE.test(lines[index] ?? "")) {
        items.push(parseMarkdownInline((lines[index] ?? "").replace(LIST_RE, "").trim()));
        index += 1;
      }
      blocks.push({ type: ordered ? "ol" : "ul", items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !LIST_RE.test(lines[index] ?? "") &&
      !isTableStart(lines, index) &&
      !(lines[index] ?? "").trim().startsWith("```")
    ) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join(" ")) });
  }

  return blocks;
}

export function parseMarkdownInline(input: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let rest = input;

  while (rest) {
    const matches = [
      matchToken(rest, /`([^`]+)`/, "code"),
      matchLink(rest),
      matchToken(rest, /\*\*([^*]+)\*\*/, "strong"),
      matchToken(rest, /\*([^*]+)\*/, "em"),
      matchRawUrl(rest),
    ].filter((match): match is TokenMatch => Boolean(match));
    const next = matches.sort((a, b) => a.index - b.index)[0];
    if (!next) {
      nodes.push({ type: "text", text: rest });
      break;
    }
    if (next.index > 0) nodes.push({ type: "text", text: rest.slice(0, next.index) });
    nodes.push(next.node);
    rest = rest.slice(next.index + next.length);
  }

  return nodes.length ? nodes : [{ type: "text", text: input }];
}

export function extractEmailSummaryRows(input: string): EmailSummaryRow[] {
  const rows = input
    .split(/\n+/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:[-*]\s*)?(?:\*\*)?([0-2]?\d[:.]\d{2}(?:\s?[ap]m)?)(?:\*\*)?\s*(?:[-–—]|:)\s*(?:\*)?(.+?)(?:\*)?(?:\s+(?:from|by)\s+(.+))?$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      time: match[1]?.replace(".", ":") ?? null,
      subject: stripMarkdown(match[2] ?? ""),
      from: match[3] ? stripMarkdown(match[3]) : null,
    }));
  if (rows.length) return rows;

  const subject = input.match(/(?:^|\n)\s*[-*]?\s*\*\*Subject:\*\*\s*(.+)/i)?.[1];
  const from = input.match(/(?:^|\n)\s*[-*]?\s*\*\*From:\*\*\s*(.+)/i)?.[1];
  const received = input.match(/(?:^|\n)\s*[-*]?\s*\*\*Received:\*\*\s*(.+)/i)?.[1];
  if (!subject || !from) return [];
  return [{ time: received ? stripMarkdown(received) : null, subject: stripMarkdown(subject), from: stripMarkdown(from) }];
}

export function markdownToPlainText(input: string): string {
  return input
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function activityStepForTool(toolName: string, status: PortalChatActivityStep["status"] = "done"): PortalChatActivityStep {
  const name = toolName.toLowerCase();
  if (name.startsWith("outlook_") || /mail|email|inbox/.test(name)) {
    return { key: toolName, label: "Searching mailbox", detail: "Reading permitted Outlook messages for this company.", status };
  }
  if (name.startsWith("xero_")) {
    return { key: toolName, label: "Checking Xero", detail: "Reading accounting data through the approved connector.", status };
  }
  if (/document|knowledge|search|fetch/.test(name)) {
    return { key: toolName, label: "Searching files", detail: "Looking across the company knowledge index and source documents.", status };
  }
  if (/system|connector|database/.test(name)) {
    return { key: toolName, label: "Checking connections", detail: "Inspecting connector and system status.", status };
  }
  return { key: toolName, label: titleCase(toolName.replace(/_/g, " ")), detail: "Running a permitted read tool.", status };
}

export function activityStepFromStatus(
  event: { label: string; tool?: string | null },
  status: PortalChatActivityStep["status"] = "running",
): PortalChatActivityStep {
  if (event.tool) return activityStepForTool(event.tool, status);
  return {
    key: event.label,
    label: event.label.replace(/[.…]+$/, ""),
    detail: "Working through the next safe step.",
    status,
  };
}

export function mergeActivityStatus(
  current: PortalChatActivityStep[],
  event: { label: string; tool?: string | null },
): PortalChatActivityStep[] {
  const next = activityStepFromStatus(event, "running");
  const done: PortalChatActivityStep[] = current.map((step) => ({ ...step, status: "done" as const }));
  const index = done.findIndex((step) => step.key === next.key);
  if (index >= 0) done[index] = next;
  else done.push(next);
  return done.slice(-5);
}

export function finalActivitySteps(
  current: PortalChatActivityStep[],
  tools: string[] = [],
  terminal?: string | null,
): PortalChatActivityStep[] {
  const steps: PortalChatActivityStep[] = current.map((step) => ({ ...step, status: "done" as const }));
  for (const tool of tools) {
    if (!steps.some((step) => step.key === tool)) steps.push(activityStepForTool(tool, "done"));
  }
  if (steps.length) {
    steps.push({
      key: "done",
      label: terminal === "permission_denied" ? "Permission checked" : "Done",
      detail: terminal === "permission_denied" ? "INFRA stopped before exposing data you cannot access." : "INFRA used the available evidence for this answer.",
      status: "done",
    });
  }
  return steps.slice(-6);
}

export function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="portal-chat-markdown">
      {parseMarkdownBlocks(text).map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "paragraph") return <p key={index}>{renderInline(block.children)}</p>;
  if (block.type === "code") return <pre key={index}><code>{block.text}</code></pre>;
  if (block.type === "ul") return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>;
  if (block.type === "ol") return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>;
  if (block.type !== "table") return null;
  return (
    <div key={index} className="portal-chat-table-wrap">
      <table>
        <thead>
          <tr>{block.headers.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(nodes: MarkdownInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "strong") return <strong key={index}>{node.text}</strong>;
    if (node.type === "em") return <em key={index}>{node.text}</em>;
    if (node.type === "code") return <code key={index}>{node.text}</code>;
    if (node.type === "link") {
      return (
        <a key={index} href={node.href} target="_blank" rel="noreferrer">
          {node.text}
        </a>
      );
    }
    return <span key={index}>{node.text}</span>;
  });
}

type TokenMatch = { index: number; length: number; node: MarkdownInline };

function matchToken(input: string, pattern: RegExp, type: "strong" | "em" | "code"): TokenMatch | null {
  const match = input.match(pattern);
  if (!match || match.index == null) return null;
  const text = match[1] ?? "";
  return { index: match.index, length: match[0].length, node: { type, text } };
}

function matchLink(input: string): TokenMatch | null {
  const match = input.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
  if (!match || match.index == null) return null;
  const href = safeHref(match[2] ?? "");
  if (!href) return null;
  return { index: match.index, length: match[0].length, node: { type: "link", text: match[1] ?? href, href } };
}

function matchRawUrl(input: string): TokenMatch | null {
  const match = input.match(/https?:\/\/[^\s)]+/i);
  if (!match || match.index == null) return null;
  const href = safeHref(match[0]);
  if (!href) return null;
  return { index: match.index, length: match[0].length, node: { type: "link", text: href, href } };
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index] ?? "") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? "");
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.replace(/\|/g, "").trim().length > 0;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function stripMarkdown(input: string): string {
  return markdownToPlainText(input);
}

function titleCase(input: string): string {
  return input.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
