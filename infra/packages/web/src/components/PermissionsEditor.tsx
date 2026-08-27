import { useEffect, useState } from "react";
import type { CompanyRole } from "@infra/shared";
import { api } from "../api";
import { humaniseActionLabel } from "@infra/shared";
import { XERO_PERMISSION_GROUPS, isPlatformBlockedXeroAction } from "@infra/shared";
import { Button, EmptyState, LoadingState, SectionCard, toast } from "../components";

const PERMISSION_GROUP_DEFS: Array<{ id: string; label: string; prefix: string }> = [
  { id: "knowledge", label: "Knowledge", prefix: "knowledge." },
  { id: "jobs", label: "Jobs", prefix: "bigchange." },
  { id: "customers", label: "Customers", prefix: "commusoft." },
  { id: "admin", label: "Administration", prefix: "system." },
];

function xeroGroupedPermissions(allowed: string[], denied: string[]) {
  const allowedSet = new Set(allowed);
  const allKnown = new Set([...allowed, ...denied]);
  return XERO_PERMISSION_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    description: group.description,
    items: group.actions.map((item) => ({
      action: item.action,
      label: item.label,
      allowed: allowedSet.has(item.action),
      platformBlocked: item.platformBlocked ?? isPlatformBlockedXeroAction(item.action),
      inPreset: allKnown.has(item.action),
    })),
  }));
}

function groupPermissions(allowed: string[], denied: string[]) {
  const allowedSet = new Set(allowed);
  const legacy = PERMISSION_GROUP_DEFS.map((group) => ({
    ...group,
    items: [...allowed, ...denied]
      .filter((action) => action.startsWith(group.prefix))
      .map((action) => ({
        action,
        label: humaniseActionLabel(action),
        allowed: allowedSet.has(action),
        platformBlocked: false,
        inPreset: true,
      })),
  })).filter((group) => group.items.length > 0);
  return [...xeroGroupedPermissions(allowed, denied), ...legacy];
}

export function PermissionsEditor({
  companySlug,
  roles,
}: {
  companySlug: string;
  roles: Awaited<ReturnType<typeof api.getRolePresets>>;
}) {
  const [selectedRole, setSelectedRole] = useState<string>("office_staff");
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const [initialDraft, setInitialDraft] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<
    Array<{ role: string; action: string; effect: "allow" | "deny" }>
  >([]);

  const editableRoles = roles.filter((r) => r.role !== "company_admin");
  const rolePreset = roles.find((r) => r.role === selectedRole);
  const dirty =
    [...draft.entries()].some(([k, v]) => initialDraft.get(k) !== v) ||
    [...initialDraft.entries()].some(([k, v]) => draft.get(k) !== v);

  async function loadPermissions(slug: string) {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCompanyRolePermissions(slug);
      setOverrides(data.overrides);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load permissions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (companySlug) void loadPermissions(companySlug);
  }, [companySlug]);

  useEffect(() => {
    if (!rolePreset) return;
    const map = new Map<string, boolean>();
    const xeroActions = XERO_PERMISSION_GROUPS.flatMap((g) => g.actions.map((a) => a.action));
    const allActions = [...new Set([...rolePreset.allowedActions, ...rolePreset.deniedByDefault, ...xeroActions])];
    for (const action of allActions) {
      const override = overrides.find((o) => o.role === selectedRole && o.action === action);
      if (override?.effect === "allow") map.set(action, true);
      else if (override?.effect === "deny") map.set(action, false);
      else map.set(action, rolePreset.allowedActions.includes(action as never));
    }
    for (const group of XERO_PERMISSION_GROUPS) {
      for (const item of group.actions) {
        if (!map.has(item.action)) map.set(item.action, false);
      }
    }
    setDraft(map);
    setInitialDraft(new Map(map));
  }, [rolePreset, overrides, selectedRole]);

  async function savePermissions() {
    if (!companySlug || !rolePreset) return;
    if (!window.confirm(`Save permission changes for ${rolePreset.displayName}?`)) return;
    setSaving(true);
    setError(null);
    try {
      const grants: Array<{ action: string; effect: "allow" | "deny" }> = [];
      for (const [action, allowed] of draft.entries()) {
        const presetAllowed = (rolePreset.allowedActions as string[]).includes(action);
        if (allowed !== presetAllowed) {
          grants.push({ action, effect: allowed ? "allow" : "deny" });
        }
      }
      const result = await api.saveCompanyRolePermissions(companySlug, {
        role: rolePreset.role as CompanyRole,
        grants,
      });
      setOverrides(result.overrides);
      setInitialDraft(new Map(draft));
      toast("Permissions saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save permissions");
      toast(err instanceof Error ? err.message : "Unable to save permissions", "error");
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    if (!rolePreset) return;
    const map = new Map<string, boolean>();
    const allActions = [...rolePreset.allowedActions, ...rolePreset.deniedByDefault];
    for (const action of allActions) {
      map.set(action, rolePreset.allowedActions.includes(action));
    }
    setDraft(map);
  }

  if (!companySlug) {
    return <EmptyState title="No company selected" description="Select a company to edit permissions." />;
  }

  const groups = rolePreset ? groupPermissions(rolePreset.allowedActions, rolePreset.deniedByDefault) : [];

  return (
    <SectionCard
      title="Role permissions"
      description="Adjust capabilities for each role. Company Admin presets are protected and cannot be edited."
      actions={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" size="sm" disabled={!dirty} onClick={resetToDefaults}>
            Reset to defaults
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!dirty}
            onClick={() => void savePermissions()}
          >
            Save changes
          </Button>
        </div>
      }
    >
      {dirty ? (
        <p className="muted small" style={{ marginBottom: 12 }}>
          You have unsaved permission changes.
        </p>
      ) : null}
      <div className="permissions-editor-controls">
        <label className="muted small">
          Role
          <select
            className="input"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
          >
            {editableRoles.map((role) => (
              <option key={role.role} value={role.role}>
                {role.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? <LoadingState label="Loading permissions…" /> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!loading && rolePreset ? (
        <div className="permissions-editor">
          <div className="permissions-matrix-head">
            <span>Capability</span>
            <span>{rolePreset.displayName}</span>
          </div>
          {groups.map((group) => (
            <div key={group.id} className="permission-group">
              <h4 className="permission-group-title">{group.label}</h4>
              {group.items.map((item) => (
                <label key={item.action} className="permission-row">
                  <span>
                    {item.label}
                    {item.platformBlocked ? (
                      <span className="muted small" style={{ display: "block" }}>
                        Platform restricted — cannot be enabled
                      </span>
                    ) : null}
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.get(item.action) ?? item.allowed}
                    disabled={item.platformBlocked}
                    onChange={(e) => {
                      if (item.platformBlocked) return;
                      setDraft((prev) => {
                        const next = new Map(prev);
                        next.set(item.action, e.target.checked);
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
          <details className="advanced-block">
            <summary>Advanced — technical action strings</summary>
            <p className="mono small">
              {[...draft.entries()].filter(([, v]) => v).map(([a]) => a).join(", ")}
            </p>
          </details>
        </div>
      ) : null}
    </SectionCard>
  );
}
