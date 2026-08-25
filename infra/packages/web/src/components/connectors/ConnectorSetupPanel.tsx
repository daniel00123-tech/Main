import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ConnectorDefinition, ConnectorInstance } from "@infra/shared";
import { connectorFieldLabel, taxonomyForConnector, taxonomyLabel } from "@infra/shared";
import { Notice } from "../../components";
import { api } from "../../api";

function schemaProperties(schema: Record<string, unknown>): Array<{
  name: string;
  secret: boolean;
  type: string;
}> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; format?: string }>;
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: def.type ?? "string",
    secret:
      def.format === "secret" ||
      def.format === "password" ||
      /(password|secret|token|api[_-]?key|authorization|refresh|bearer|client[_-]?secret|private[_-]?key|access[_-]?token)/i.test(
        name,
      ),
  }));
}

export function ConnectorSetupPanel({
  connector,
  companySlug,
  instance,
  onChanged,
}: {
  connector: ConnectorDefinition;
  companySlug: string;
  instance?: ConnectorInstance | null;
  onChanged?: () => Promise<void> | void;
}) {
  const credentialFields = useMemo(
    () => schemaProperties(connector.credentialSchema),
    [connector],
  );
  const configFields = useMemo(
    () => schemaProperties(connector.configSchema),
    [connector],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [storage, setStorage] = useState<{
    enabled: boolean;
    reason: string;
    xero?: {
      appConfigured: boolean;
      storageEnabled: boolean;
      readyToConnect: boolean;
      scopes: string[];
    };
  } | null>(null);
  const [metadata, setMetadata] = useState<{
    stored: boolean;
    lastUpdated: string | null;
    fields: Array<{ name: string; masked: true }>;
    xero?: {
      organisationName: string | null;
      organisationSelected: boolean;
      pendingOrganisations: Array<{ tenantId: string; name: string }>;
      authStatus: string | null;
      connectedAt: string | null;
      lastCheckedAt: string | null;
      grantedScopes: string[];
    };
  } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const oauth = connector.authenticationMethod === "oauth";
  const apiKey = connector.authenticationMethod === "api_key";
  const xero = connector.slug === "xero";
  const xeroReady = Boolean(storage?.xero?.readyToConnect);
  const xeroView = metadata?.xero;

  useEffect(() => {
    void (async () => {
      try {
        const status = await api.getCredentialStorage();
        setStorage(status);
        if (instance?.id) {
          const meta = await api.getConnectorCredentialMetadata(companySlug, instance.id);
          setMetadata(meta);
          setReplacing(!meta.stored);
        } else {
          setMetadata(null);
          setReplacing(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load credential status");
      }
    })();
  }, [companySlug, instance?.id]);

  async function ensureInstance(): Promise<string> {
    if (instance?.id) return instance.id;
    const created = await api.setupConnector(companySlug, connector.id, {
      name: `${connector.name}`,
    });
    return created.id;
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!storage?.enabled) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const instanceId = await ensureInstance();
      const credentials = Object.fromEntries(
        credentialFields
          .filter((field) => field.secret && values[field.name])
          .map((field) => [field.name, values[field.name]]),
      );
      const config = Object.fromEntries(
        [...credentialFields, ...configFields]
          .filter((field) => !field.secret && values[field.name])
          .map((field) => [field.name, values[field.name]]),
      );
      if (metadata?.stored && instance?.id) {
        await api.rotateConnectorCredentials(companySlug, instanceId, {
          credentials,
          config,
        });
      } else {
        await api.saveConnectorCredentials(companySlug, instanceId, {
          credentials,
          config,
        });
      }
      setValues({});
      setReplacing(false);
      const meta = await api.getConnectorCredentialMetadata(companySlug, instanceId);
      setMetadata(meta);
      setMessage("Stored securely. This connector has no provider test yet, so it is not marked Connected.");
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save credentials");
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!instance?.id) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.testConnectorConnection(companySlug, instance.id);
      setMessage(result.message ?? "No provider test is available for this connector yet.");
      const meta = await api.getConnectorCredentialMetadata(companySlug, instance.id);
      setMetadata(meta);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  async function onConnectXero() {
    setBusy(true);
    setError(null);
    try {
      const started = await api.startConnectorOAuth(companySlug, connector.id);
      window.location.assign(started.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start Xero connection");
      setBusy(false);
    }
  }

  async function onSelectOrg(tenantId: string) {
    if (!instance?.id) return;
    setBusy(true);
    setError(null);
    try {
      await api.selectXeroOrganisation(companySlug, instance.id, tenantId);
      const meta = await api.getConnectorCredentialMetadata(companySlug, instance.id);
      setMetadata(meta);
      setMessage("Xero organisation confirmed.");
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to select organisation");
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (!instance?.id) return;
    setBusy(true);
    setError(null);
    try {
      await api.disconnectConnector(companySlug, instance.id);
      setMetadata({ stored: false, lastUpdated: null, fields: metadata?.fields ?? [] });
      setReplacing(true);
      setMessage("Disconnected. Stored credentials were revoked.");
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to disconnect");
    } finally {
      setBusy(false);
    }
  }

  const storageEnabled = Boolean(storage?.enabled);
  const showStored = Boolean(metadata?.stored) && !replacing;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {!storageEnabled ? (
        <Notice tone="warning">
          Secure credential storage is not configured. Save &amp; Test stays disabled until
          the wrapping key is set.
        </Notice>
      ) : (
        <Notice tone="info">
          Secrets are encrypted before they are stored. INFRA never shows the saved value again.
        </Notice>
      )}

      <p className="muted" style={{ margin: 0 }}>
        {taxonomyLabel(taxonomyForConnector(connector))} ·{" "}
        {oauth ? "OAuth sign-in" : apiKey ? "API credentials" : "Company MCP managed"}
      </p>

      {connector.setupInstructions ? (
        <p className="muted" style={{ margin: 0 }}>
          {connector.setupInstructions}
        </p>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}

      {oauth ? (
        <div className="stack" style={{ gap: 12 }}>
          {xero && !xeroReady ? (
            <Notice tone="warning">
              {storage?.enabled
                ? "The Xero application is not configured. Connect Xero stays disabled until the Client ID and Client Secret are set as Worker secrets."
                : "Secure credential storage is not configured."}
            </Notice>
          ) : null}
          <div className="muted small">
            Status:{" "}
            {instance?.authStatus === "connected"
              ? "Connected"
              : instance?.authStatus === "configuring"
                ? "Connecting"
                : instance?.authStatus === "auth_expired"
                  ? "Authentication expired"
                  : instance?.authStatus === "rotation_required"
                    ? "Reconnect required"
                    : instance?.authStatus === "revoked"
                      ? "Disconnected"
                      : instance?.authStatus === "error"
                        ? "Error"
                        : "Not connected"}
          </div>
          {xeroView?.organisationName ? (
            <div>
              <div className="muted small">Xero organisation</div>
              <div>{xeroView.organisationName}</div>
            </div>
          ) : null}
          {xeroView?.connectedAt ? (
            <div className="muted small">Connected: {xeroView.connectedAt}</div>
          ) : null}
          {xeroView?.lastCheckedAt ? (
            <div className="muted small">Last API check: {xeroView.lastCheckedAt}</div>
          ) : null}
          {xeroView?.grantedScopes?.length ? (
            <div className="muted small">
              Granted capabilities: {xeroView.grantedScopes.join(", ")}
            </div>
          ) : null}
          {xeroView?.pendingOrganisations?.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <p style={{ margin: 0 }}>Select the Xero organisation to finish connecting.</p>
              {xeroView.pendingOrganisations.map((org) => (
                <button
                  key={org.tenantId}
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void onSelectOrg(org.tenantId)}
                >
                  Use {org.name}
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              className="button button-primary"
              disabled={!xeroReady || busy}
              onClick={() => void onConnectXero()}
            >
              {instance?.authStatus === "connected" || instance?.authStatus === "auth_expired"
                ? "Reconnect Xero"
                : "Connect Xero"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !instance?.id}
              onClick={() => void onTest()}
            >
              Test connection
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !instance?.id}
              onClick={() => void onDisconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}

      {showStored && !oauth ? (
        <div className="stack" style={{ gap: 12 }}>
          {(metadata?.fields.length ? metadata.fields : credentialFields).map((field) => (
            <div key={field.name}>
              <div className="muted small">{connectorFieldLabel(field.name)}</div>
              <div>••••••••••••</div>
              <div className="muted small">Stored securely</div>
            </div>
          ))}
          <div className="muted small">
            Last updated: {metadata?.lastUpdated ?? "Unavailable"}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              className="button button-secondary"
              disabled={!storageEnabled || busy}
              onClick={() => {
                setReplacing(true);
                setValues({});
              }}
            >
              Reconnect / Replace
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !instance?.id}
              onClick={() => void onTest()}
            >
              Test connection
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !instance?.id}
              onClick={() => void onDisconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}

      {!showStored && !oauth && (credentialFields.length > 0 || configFields.length > 0) ? (
        <form className="stack" style={{ gap: 16 }} onSubmit={(event) => void onSave(event)}>
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
                      disabled={!storageEnabled || busy}
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
                      disabled={busy}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <button type="submit" className="button button-primary" disabled={!storageEnabled || busy}>
            {storageEnabled
              ? busy
                ? "Saving…"
                : apiKey
                  ? "Save & Test"
                  : "Save credentials"
              : "Save & Test — disabled"}
          </button>
        </form>
      ) : null}

      {!showStored && credentialFields.length === 0 && configFields.length === 0 && !oauth ? (
        <p className="muted">This connector does not declare setup fields yet.</p>
      ) : null}
    </div>
  );
}
