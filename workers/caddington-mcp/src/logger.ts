type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

export function log(
  level: LogLevel,
  message: string,
  fields: LogFields = {}
): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    service: "caddington-mcp",
    ...fields,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}
