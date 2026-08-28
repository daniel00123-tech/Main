import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import type { AutomationDefinitionRecord, AutomationRunRecord } from "@infra/shared";
import { api } from "../api";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  MobileRecordCard,
  MobileRecordList,
  SectionCard,
  StatusBadge,
  Field,
  Input,
  Select,
  Textarea,
  toast,
  useIsMobile,
} from "../components";
import { formatRelativeTime } from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

function humanAutomationStatus(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "draft":
      return "Draft";
    case "paused":
      return "Paused";
    case "disabled":
      return "Disabled";
    case "error":
      return "Error";
    default:
      return status;
  }
}

function humanRunStatus(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function triggerLabel(automation: AutomationDefinitionRecord): string {
  if (automation.triggerType === "manual") return "Manual";
  if (automation.schedule) {
    const hour = String(automation.schedule.hour ?? 0).padStart(2, "0");
    const minute = String(automation.schedule.minute ?? 0).padStart(2, "0");
    return `${automation.schedule.frequency} at ${hour}:${minute} (${automation.timezone})`;
  }
  return automation.triggerType;
}

export default function PortalAutomationsPage() {
  const { company, loading, error, membership, user } = usePortalCompany();
  const [automations, setAutomations] = useState<AutomationDefinitionRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTrigger, setFormTrigger] = useState<"manual" | "schedule">("manual");
  const [formFrequency, setFormFrequency] = useState("daily");
  const [formHour, setFormHour] = useState("8");
  const [formMinute, setFormMinute] = useState("0");
  const [formTimezone, setFormTimezone] = useState("Europe/London");
  const [formPrompt, setFormPrompt] = useState("");

  const canManage =
    user?.isPlatformAdmin ||
    membership?.role === "company_admin" ||
    membership?.role === "director";

  const selected = useMemo(
    () => automations.find((item) => item.id === selectedId) ?? null,
    [automations, selectedId],
  );

  const loadAutomations = useCallback(async () => {
    if (!company) return;
    setListLoading(true);
    setListError(null);
    try {
      const response = await api.listCompanyAutomations(company.slug);
      setAutomations(response.automations);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load automations");
    } finally {
      setListLoading(false);
    }
  }, [company]);

  const loadRuns = useCallback(
    async (automationId: string) => {
      if (!company) return;
      setRunsLoading(true);
      try {
        const response = await api.listCompanyAutomationRuns(company.slug, automationId);
        setRuns(response.runs);
      } catch {
        setRuns([]);
      } finally {
        setRunsLoading(false);
      }
    },
    [company],
  );

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  useEffect(() => {
    if (selectedId) void loadRuns(selectedId);
  }, [selectedId, loadRuns]);

  async function handleCreate() {
    if (!company || !formName.trim() || !formPrompt.trim()) {
      toast("Name and instruction are required", "error");
      return;
    }
    setBusy("create");
    try {
      const created = await api.createCompanyAutomation(company.slug, {
        name: formName.trim(),
        description: formDescription.trim() || undefined,
        triggerType: formTrigger,
        schedule:
          formTrigger === "schedule"
            ? {
                frequency: formFrequency,
                hour: Number(formHour),
                minute: Number(formMinute),
              }
            : undefined,
        timezone: formTimezone,
        actionType: "ai_prompt",
        configuration: { prompt: formPrompt.trim() },
      });
      await api.activateCompanyAutomation(company.slug, created.automation.id);
      toast("Automation created and activated");
      setCreateOpen(false);
      setFormName("");
      setFormDescription("");
      setFormPrompt("");
      await loadAutomations();
      setSelectedId(created.automation.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create automation", "error");
    } finally {
      setBusy(null);
    }
  }

  async function handleAction(
    action: "run" | "pause" | "activate" | "disable",
    automationId: string,
  ) {
    if (!company) return;
    setBusy(`${action}-${automationId}`);
    try {
      if (action === "run") {
        const result = await api.runCompanyAutomation(company.slug, automationId);
        toast(result.run.status === "queued" ? "Run queued" : "Run started");
      } else if (action === "pause") {
        await api.pauseCompanyAutomation(company.slug, automationId);
        toast("Automation paused");
      } else if (action === "activate") {
        await api.activateCompanyAutomation(company.slug, automationId);
        toast("Automation activated");
      } else {
        await api.disableCompanyAutomation(company.slug, automationId);
        toast("Automation disabled");
      }
      await loadAutomations();
      if (selectedId === automationId) void loadRuns(automationId);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <LoadingState label="Loading company…" />;
  if (error || !company) return <ErrorState message={error ?? "Company not found"} />;

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="Automations"
        description="Schedule AI instructions and run them on demand within your company context."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>New automation</Button>
          ) : undefined
        }
      />

      {listLoading ? (
        <LoadingState label="Loading automations…" />
      ) : listError ? (
        <ErrorState message={listError} />
      ) : automations.length === 0 ? (
        <EmptyState
          icon={<Bot size={32} />}
          title="No automations yet"
          description="Create a scheduled or manual AI instruction to automate recurring work."
          action={
            canManage ? (
              <Button onClick={() => setCreateOpen(true)}>Create automation</Button>
            ) : undefined
          }
        />
      ) : isMobile ? (
        <MobileRecordList>
          {automations.map((automation) => (
            <MobileRecordCard key={automation.id} onClick={() => setSelectedId(automation.id)}>
              <div className="mobile-record-head">
                <strong>{automation.name}</strong>
                <StatusBadge
                  status={automation.status}
                  label={humanAutomationStatus(automation.status)}
                />
              </div>
              <div className="muted small">{triggerLabel(automation)}</div>
              {automation.lastRunAt ? (
                <div className="muted small">Last run {formatRelativeTime(automation.lastRunAt)}</div>
              ) : null}
            </MobileRecordCard>
          ))}
        </MobileRecordList>
      ) : (
        <SectionCard title="Automations">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Last run</th>
                  <th>Next run</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {automations.map((automation) => (
                  <tr key={automation.id}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setSelectedId(automation.id)}
                      >
                        {automation.name}
                      </button>
                    </td>
                    <td>
                      <StatusBadge
                        status={automation.status}
                        label={humanAutomationStatus(automation.status)}
                      />
                    </td>
                    <td>{triggerLabel(automation)}</td>
                    <td>{automation.lastRunAt ? formatRelativeTime(automation.lastRunAt) : "—"}</td>
                    <td>{automation.nextRunAt ? formatRelativeTime(automation.nextRunAt) : "—"}</td>
                    <td className="table-actions">
                      {canManage ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy !== null || automation.status === "disabled"}
                            onClick={() => void handleAction("run", automation.id)}
                          >
                            Run
                          </Button>
                          {automation.status === "active" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => void handleAction("pause", automation.id)}
                            >
                              Pause
                            </Button>
                          ) : automation.status !== "disabled" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => void handleAction("activate", automation.id)}
                            >
                              Activate
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? "Automation"}
      >
        {selected ? (
          <>
            <KeyValue label="Status" value={humanAutomationStatus(selected.status)} />
            <KeyValue label="Trigger" value={triggerLabel(selected)} />
            <KeyValue
              label="Instruction"
              value={
                typeof selected.configuration.prompt === "string"
                  ? selected.configuration.prompt
                  : "—"
              }
            />
            {canManage ? (
              <div className="drawer-actions">
                <Button
                  disabled={busy !== null || selected.status === "disabled"}
                  onClick={() => void handleAction("run", selected.id)}
                >
                  Run now
                </Button>
                {selected.status === "active" ? (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void handleAction("pause", selected.id)}
                  >
                    Pause
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void handleAction("activate", selected.id)}
                  >
                    Activate
                  </Button>
                )}
              </div>
            ) : null}

            <SectionCard title="Recent runs">
              {runsLoading ? (
                <LoadingState label="Loading runs…" />
              ) : runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
              ) : (
                <ul className="simple-list">
                  {runs.slice(0, 10).map((run) => (
                    <li key={run.id}>
                      <strong>{humanRunStatus(run.status)}</strong>
                      {" · "}
                      {formatRelativeTime(run.createdAt)}
                      {run.durationMs != null ? ` · ${run.durationMs}ms` : ""}
                      {run.resultSummary ? (
                        <div className="muted truncate">{run.resultSummary}</div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </>
        ) : null}
      </Drawer>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="Create automation">
        <Field label="Name">
          <Input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input
            className="input"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
          />
        </Field>
        <Field label="Trigger">
          <Select
            className="input"
            value={formTrigger}
            onChange={(e) => setFormTrigger(e.target.value as "manual" | "schedule")}
          >
            <option value="manual">Manual</option>
            <option value="schedule">Scheduled</option>
          </Select>
        </Field>
        {formTrigger === "schedule" ? (
          <>
            <Field label="Frequency">
              <Select
                className="input"
                value={formFrequency}
                onChange={(e) => setFormFrequency(e.target.value)}
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </Field>
            <div className="form-row">
              <Field label="Hour">
                <Input className="input" value={formHour} onChange={(e) => setFormHour(e.target.value)} />
              </Field>
              <Field label="Minute">
                <Input
                  className="input"
                  value={formMinute}
                  onChange={(e) => setFormMinute(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Timezone">
              <Input
                className="input"
                value={formTimezone}
                onChange={(e) => setFormTimezone(e.target.value)}
              />
            </Field>
          </>
        ) : null}
        <Field label="AI instruction">
          <Textarea
            className="input"
            value={formPrompt}
            onChange={(e) => setFormPrompt(e.target.value)}
            rows={6}
            placeholder="Every weekday, summarise yesterday's operational activity for leadership."
          />
        </Field>
        <div className="drawer-actions">
          <Button disabled={busy === "create"} onClick={() => void handleCreate()}>
            Create & activate
          </Button>
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
