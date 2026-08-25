import { useMemo, useState } from "react";
import type { ConnectorDefinition } from "@infra/shared";
import { Notice } from "../../components";

function schemaProperties(schema: Record<string, unknown>): Array<{
  name: string;
  secret: boolean;
  type: string;
}> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; format?: string }>;
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: def.type ?? "string",
    secret: def.format === "secret",
  }));
}

export function ConnectorSetupPanel({ connector }: { connector: ConnectorDefinition }) {
  const fields = useMemo(
    () => [
      ...schemaProperties(connector.credentialSchema).map((field) => ({
        ...field,
        group: "credential" as const,
      })),
      ...schemaProperties(connector.configSchema).map((field) => ({
        ...field,
        group: "config" as const,
      })),
    ],
    [connector],
  );
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="stack" style={{ gap: 12 }}>
      <Notice tone="warning">
        Secure credential storage is not enabled. Fields below describe the future setup
        contract. Submission is disabled so secrets are never posted to INFRA.
      </Notice>
      {connector.setupInstructions ? (
        <p className="muted" style={{ margin: 0 }}>
          {connector.setupInstructions}
        </p>
      ) : null}
      {fields.length === 0 ? (
        <p className="muted">This connector does not declare setup fields yet.</p>
      ) : (
        <div className="form-grid">
          {fields.map((field) => (
            <label key={`${field.group}-${field.name}`}>
              {field.name}
              {field.secret ? " (secret — not stored)" : ""}
              <input
                type={field.secret ? "password" : "text"}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                }
                autoComplete="off"
              />
            </label>
          ))}
        </div>
      )}
      <button type="button" className="button button-primary" disabled>
        Save credentials — disabled
      </button>
    </div>
  );
}
