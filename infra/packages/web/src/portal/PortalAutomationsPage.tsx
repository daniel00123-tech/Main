import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import type { AutomationDefinitionRecord, AutomationRunRecord } from "@infra/shared";
import {
  automationRecipientEmailOf,
  automationTemplateKeyOf,
  humanAutomationCustomerStatus,
  humanAutomationNextRun,
  humanAutomationRunCustomerStatus,
  humanAutomationRunCustomerSummary,
  humanAutomationSchedule,
  humanAutomationWhen,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
  createdViaLabel,
  type AutomationCreatedVia,
  type AutomationScheduleFrequency,
} from "@infra/shared";
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
  toast,
  useIsMobile,
} from "../components";
import { PortalPageBody, PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

type TemplateOption = {
  key: string;
  label: string;
  description: string;
  system: string;
  defaultName: string;
  defaultTimezone: string;
  defaultSchedule?: { frequency?: string; hour?: number; minute?: number };
  available: boolean;
};

type PortalAutomation = AutomationDefinitionRecord & {
  templateKey?: string | null;
  templateLabel?: string | null;
  recipientEmail?: string | null;
  createdVia?: AutomationCreatedVia | null;
  archived?: boolean;
};

function clockValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export default function PortalAutomationsPage() {
  const { company, loading, error, membership, user } = usePortalCompany();
  const [automations, setAutomations] = useState<PortalAutomation[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const [templateKey, setTemplateKey] = useState<string>(XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE);
  const [formName, setFormName] = useState("Daily month-to-date sales");
  const [formTime, setFormTime] = useState("08:00");
  const [formTimezone, setFormTimezone] = useState("Europe/London");
  const [formRecipient, setFormRecipient] = useState("");
  const [formFrequency, setFormFrequency] = useState<AutomationScheduleFrequency>("daily");

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
      const [response, catalog] = await Promise.all([
        api.listCompanyAutomations(company.slug),
        api.listAutomationTemplates().catch(() => ({ templates: [] })),
      ]);
      setAutomations(response.automations);
      setTemplates(catalog.templates);
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

  function openCreate() {
    setTemplateKey(XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE);
    setFormName("Daily month-to-date sales");
    setFormTime("08:00");
    setFormTimezone(company?.timezone || "Europe/London");
    setFormRecipient(user?.email ?? "");
    setFormFrequency("daily");
    setCreateOpen(true);
  }

  function openEdit(automation: PortalAutomation) {
    setFormName(automation.name);
    setFormTime(clockValue(automation.schedule?.hour ?? 8, automation.schedule?.minute ?? 0));
    setFormTimezone(automation.timezone || "Europe/London");
    setFormRecipient(
      automation.recipientEmail ?? automationRecipientEmailOf(automation.configuration) ?? "",
    );
    setFormFrequency(automation.schedule?.frequency ?? "daily");
    setSelectedId(automation.id);
    setEditOpen(true);
  }

  async function handleCreate() {
    if (!company || !formName.trim() || !formRecipient.trim()) {
      toast("Name and recipient are required", "error");
      return;
    }
    const [hour, minute] = formTime.split(":").map(Number);
    setBusy("create");
    try {
      const created = await api.createCompanyAutomationFromTemplate(company.slug, {
        templateKey,
        name: formName.trim(),
        recipientEmail: formRecipient.trim(),
        timezone: formTimezone,
        hour: Number.isFinite(hour) ? hour : 8,
        minute: Number.isFinite(minute) ? minute : 0,
        frequency: formFrequency,
        activate: true,
      });
      toast("Automation created");
      setCreateOpen(false);
      await loadAutomations();
      setSelectedId(created.automation.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create automation", "error");
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveEdit() {
    if (!company || !selected) return;
    const [hour, minute] = formTime.split(":").map(Number);
    const template =
      selected.templateKey ??
      automationTemplateKeyOf(selected.configuration) ??
      XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE;
    setBusy("edit");
    try {
      await api.updateCompanyAutomation(company.slug, selected.id, {
        name: formName.trim(),
        timezone: formTimezone,
        triggerType: "schedule",
        schedule: {
          frequency: formFrequency,
          hour: Number.isFinite(hour) ? hour : 8,
          minute: Number.isFinite(minute) ? minute : 0,
        },
        actionType: "internal",
        configuration: {
          handler: template,
          templateKey: template,
          parameters: { recipientEmail: formRecipient.trim().toLowerCase() },
        },
      });
      toast("Automation updated");
      setEditOpen(false);
      await loadAutomations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update automation", "error");
    } finally {
      setBusy(null);
    }
  }

  async function handleAction(
    action: "run" | "pause" | "activate" | "disable" | "archive",
    automationId: string,
  ) {
    if (!company) return;
    setBusy(`${action}-${automationId}`);
    try {
      if (action === "run") {
        const result = await api.runCompanyAutomation(company.slug, automationId);
        toast(result.run.status === "queued" ? "Run started" : "Run started");
      } else if (action === "pause") {
        await api.pauseCompanyAutomation(company.slug, automationId);
        toast("Automation paused");
      } else if (action === "activate") {
        await api.activateCompanyAutomation(company.slug, automationId);
        toast("Automation activated");
      } else if (action === "archive") {
        await api.archiveCompanyAutomation(company.slug, automationId);
        toast("Automation archived");
        if (selectedId === automationId) setSelectedId(null);
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

  if (loading || !company) return <LoadingState label="Loading company…" />;
  if (error) return <ErrorState message={error} />;

  const availableTemplates = templates.filter((item) => item.available);
  const selectedTemplate =
    availableTemplates.find((item) => item.key === templateKey) ?? availableTemplates[0] ?? null;

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="Automations"
        description="Recurring work INFRA can do for your company."
        actions={
          canManage ? (
            <Button onClick={openCreate}>Create automation</Button>
          ) : undefined
        }
      />

      <PortalPageBody
        loading={listLoading}
        error={listError}
        loadingLabel="Loading automations…"
        errorTitle="We couldn't load your automations"
        onRetry={() => void loadAutomations()}
      >
        {automations.length === 0 ? (
          <EmptyState
            icon={<Bot size={32} />}
            title="No automations yet"
            description="Create a daily sales email or a daily document activity report."
            action={
              canManage ? (
                <Button onClick={openCreate}>Create automation</Button>
              ) : undefined
            }
          />
        ) : isMobile ? (
          <MobileRecordList>
            {automations.map((automation) => (
              <MobileRecordCard key={automation.id}>
                <div className="mobile-record-head">
                  <strong>{automation.name}</strong>
                  <StatusBadge
                    status={automation.status}
                    label={humanAutomationCustomerStatus(automation.status)}
                  />
                </div>
                <div className="muted small">{humanAutomationSchedule(automation)}</div>
                <div className="muted small">
                  Next run {humanAutomationNextRun(automation.nextRunAt, automation.timezone)}
                </div>
                {automation.recipientEmail ? (
                  <div className="muted small">Recipient {automation.recipientEmail}</div>
                ) : null}
                <div className="mobile-record-actions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setSelectedId(automation.id)}>
                    Open
                  </Button>
                  {canManage ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null || automation.status === "disabled"}
                        onClick={() => void handleAction("run", automation.id)}
                      >
                        Run now
                      </Button>
                      {automation.status === "active" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => void handleAction("pause", automation.id)}
                        >
                          Pause
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </MobileRecordCard>
            ))}
          </MobileRecordList>
        ) : (
          <SectionCard title="Your automations">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Schedule</th>
                    <th>Next run</th>
                    <th>Last run</th>
                    <th>Recipient</th>
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
                          label={humanAutomationCustomerStatus(automation.status)}
                        />
                      </td>
                      <td>{humanAutomationSchedule(automation)}</td>
                      <td>{humanAutomationNextRun(automation.nextRunAt, automation.timezone)}</td>
                      <td>
                        {automation.lastRunAt
                          ? humanAutomationWhen(automation.lastRunAt, automation.timezone)
                          : "—"}
                      </td>
                      <td>{automation.recipientEmail ?? "—"}</td>
                      <td className="table-actions">
                        {canManage ? (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null || automation.status === "disabled"}
                              onClick={() => void handleAction("run", automation.id)}
                            >
                              Run now
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => openEdit(automation)}
                            >
                              Edit
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
                                Resume
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => {
                                if (window.confirm(`Archive '${automation.name}'? Run history is kept.`)) {
                                  void handleAction("archive", automation.id);
                                }
                              }}
                            >
                              Delete
                            </Button>
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
      </PortalPageBody>

      <Drawer
        open={Boolean(selected) && !editOpen}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? "Automation"}
      >
        {selected ? (
          <>
            <KeyValue label="Status" value={humanAutomationCustomerStatus(selected.status)} />
            <KeyValue label="Schedule" value={humanAutomationSchedule(selected)} />
            <KeyValue label="Timezone" value={selected.timezone} />
            <KeyValue
              label="Recipient"
              value={
                selected.recipientEmail ??
                automationRecipientEmailOf(selected.configuration) ??
                "—"
              }
            />
            <KeyValue
              label="Next run"
              value={humanAutomationNextRun(selected.nextRunAt, selected.timezone)}
            />
            <KeyValue
              label="Last run"
              value={
                selected.lastRunAt
                  ? humanAutomationWhen(selected.lastRunAt, selected.timezone)
                  : "—"
              }
            />
            <KeyValue label="Created from" value={createdViaLabel(selected.createdVia)} />
            {canManage ? (
              <div className="drawer-actions">
                <Button
                  disabled={busy !== null || selected.status === "disabled"}
                  onClick={() => void handleAction("run", selected.id)}
                >
                  Run now
                </Button>
                <Button variant="secondary" disabled={busy !== null} onClick={() => openEdit(selected)}>
                  Edit
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
                    Resume
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Archive '${selected.name}'? Run history is kept.`)) {
                      void handleAction("archive", selected.id);
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            ) : null}

            <SectionCard title="Recent runs">
              {runsLoading ? (
                <LoadingState label="Loading runs…" />
              ) : runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
              ) : (
                <ul className="simple-list">
                  {runs.slice(0, 12).map((run) => (
                    <li key={run.id}>
                      <strong>{humanAutomationWhen(run.createdAt, selected.timezone)}</strong>
                      {" · "}
                      {humanAutomationRunCustomerStatus(run.status)}
                      <div className="muted">
                        {humanAutomationRunCustomerSummary({
                          status: run.status,
                          resultSummary: run.resultSummary,
                          errorCode: run.errorCode,
                          errorMessage: run.errorMessage,
                          result: run.result,
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </>
        ) : null}
      </Drawer>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="Create automation">
        <p className="muted small">What would you like INFRA to do?</p>
        <Field label="Automation">
          <Select
            className="input"
            value={templateKey}
            onChange={(event) => {
              const next = event.target.value;
              setTemplateKey(next);
              const match = availableTemplates.find((item) => item.key === next);
              if (match) {
                setFormName(match.defaultName);
                setFormTime(
                  clockValue(match.defaultSchedule?.hour ?? 8, match.defaultSchedule?.minute ?? 0),
                );
                setFormTimezone(match.defaultTimezone || "Europe/London");
                setFormFrequency(
                  (match.defaultSchedule?.frequency as AutomationScheduleFrequency) || "daily",
                );
              }
            }}
          >
            {(availableTemplates.length > 0 ? availableTemplates : [
              {
                key: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
                label: "Daily sales email",
              },
            ]).map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <p className="muted small">
          {selectedTemplate?.description ??
            "Receive your current month's Xero sales by email every morning."}
        </p>
        <Field label="Name">
          <Input className="input" value={formName} onChange={(event) => setFormName(event.target.value)} />
        </Field>
        <Field label="System">
          <Input className="input" value={selectedTemplate?.system ?? "Xero"} disabled />
        </Field>
        <Field label="Every">
          <Select
            className="input"
            value={formFrequency}
            onChange={(event) =>
              setFormFrequency(event.target.value as AutomationScheduleFrequency)
            }
          >
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </Field>
        <Field label="Time">
          <Input
            className="input"
            type="time"
            value={formTime}
            onChange={(event) => setFormTime(event.target.value)}
          />
        </Field>
        <Field label="Timezone">
          <Select
            className="input"
            value={formTimezone}
            onChange={(event) => setFormTimezone(event.target.value)}
          >
            <option value="Europe/London">Europe/London</option>
            <option value="Europe/Dublin">Europe/Dublin</option>
            <option value="UTC">UTC</option>
          </Select>
        </Field>
        <Field label="Send report to">
          <Input
            className="input"
            type="email"
            value={formRecipient}
            onChange={(event) => setFormRecipient(event.target.value)}
          />
        </Field>
        <div className="drawer-actions">
          <Button disabled={busy === "create"} onClick={() => void handleCreate()}>
            Create automation
          </Button>
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>
        </div>
      </Drawer>

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Edit automation">
        <Field label="Name">
          <Input className="input" value={formName} onChange={(event) => setFormName(event.target.value)} />
        </Field>
        <Field label="Every">
          <Select
            className="input"
            value={formFrequency}
            onChange={(event) =>
              setFormFrequency(event.target.value as AutomationScheduleFrequency)
            }
          >
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </Field>
        <Field label="Time">
          <Input
            className="input"
            type="time"
            value={formTime}
            onChange={(event) => setFormTime(event.target.value)}
          />
        </Field>
        <Field label="Timezone">
          <Select
            className="input"
            value={formTimezone}
            onChange={(event) => setFormTimezone(event.target.value)}
          >
            <option value="Europe/London">Europe/London</option>
            <option value="Europe/Dublin">Europe/Dublin</option>
            <option value="UTC">UTC</option>
          </Select>
        </Field>
        <Field label="Send report to">
          <Input
            className="input"
            type="email"
            value={formRecipient}
            onChange={(event) => setFormRecipient(event.target.value)}
          />
        </Field>
        <div className="drawer-actions">
          <Button disabled={busy === "edit"} onClick={() => void handleSaveEdit()}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setEditOpen(false)}>
            Cancel
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
