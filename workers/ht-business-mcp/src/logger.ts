type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

function serialize(fields: LogFields): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
  ...fields,
  });
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const entry = serialize({ level, message, ...fields });
  switch (level) {
    case "error":
      console.error(entry);
      break;
    case "warn":
      console.warn(entry);
      break;
    default:
      console.log(entry);
  }
}
