import { useMemo, useState } from "react";
import type { ConnectorDefinition } from "@infra/shared";
import { connectorFieldLabel, taxonomyForConnector, taxonomyLabel } from "@infra/shared";
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
  const credentialFields = useMemo(
    () => schemaProperties(connector.credentialSchema),
    [connector],
  );
  const configFields = useMemo(
    () => schemaProperties(connector.configSchema),
    [connector],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const oauth = connector.authenticationMethod === "oauth";
  const apiKey = connector.authenticationMethod === "api_key";

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Notice tone="warning">
        Secure credential storage is not enabled. You can review the setup contract, but
        secrets are never posted to INFRA.
      </Notice>

      <p className="muted" style={{ margin: 0 }}>
        {taxonomyLabel(taxonomyForConnector(connector))} ·{" "}
        {oauth ? "OAuth sign-in" : apiKey ? "API credentials" : "Company MCP managed"}
      </p>

      {connector.setupInstructions ? (
        <p className="muted" style={{ margin: 0 }}>
          {connector.setupInstructions}
        </p>
      ) : null}

      {oauth ? (
        <div className="stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>
            Staff will click Connect, sign in with the provider, then return here. Tokens
            will be stored only after a secure secret provider is enabled.
          </p>
          <button type="button" className="button button-primary" disabled>
            Connect with {connector.name} — not activated
          </button>
        </div>
      ) : null}

      {credentialFields.length > 0 || configFields.length > 0 ? (
        <form
          className="stack"
          style={{ gap: 16 }}
          onSubmit={(event) => event.preventDefault()}
        >
          {credentialFields.length > 0 ? (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="muted small">Credentials</legend>
              <div className="form-grid" style={{ marginTop: 8 }}>
                {credentialFields.map((field) => (
                  <label key={`credential-${field.name}`} htmlFor={`cred-${field.name}`}>
                    {connectorFieldLabel(field.name)}
                    {field.secret ? " (kept private)" : ""}
                    <input
                      id={`cred-${field.name}`}
                      type={field.secret ? "password" : "text"}
                      value={values[field.name] ?? ""}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                      }
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {configFields.length > 0 ? (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="muted small">Configuration</legend>
              <div className="form-grid" style={{ marginTop: 8 }}>
                {configFields.map((field) => (
                  <label key={`config-${field.name}`} htmlFor={`cfg-${field.name}`}>
                    {connectorFieldLabel(field.name)}
                    <input
                      id={`cfg-${field.name}`}
                      type={field.type === "boolean" ? "checkbox" : "text"}
                      value={field.type === "boolean" ? undefined : (values[field.name] ?? "")}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                      }
                      autoComplete="off"
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <button type="submit" className="button button-primary" disabled>
            {apiKey ? "Save and test — disabled" : "Save credentials — disabled"}
          </button>
        </form>
      ) : (
        <p className="muted">This connector does not declare setup fields yet.</p>
      )}
    </div>
  );
}
