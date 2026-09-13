import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  CONNECTOR_CATALOGUE,
  connectorOverviewDescription,
  deriveConnectorCustomerHealth,
  displayConversationTitle,
  groupConversations,
  isCustomerConnectedConnector,
  type CompanyOverview,
} from "@infra/shared";
import {
  Bot,
  ChevronLeft,
  CircleDashed,
  FileSearch,
  Inbox,
  Landmark,
  Menu,
  MessageSquare,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  formatRelativeTime,
  useMediaQuery,
} from "../components";
import { api, type PortalChatConversation, type PortalChatMessage, type PortalChatTurnResult } from "../api";
import { usePortalCompany } from "./usePortalCompany";
import {
  composerSendDisabled,
  emptyStatePrompts,
  followUpHints,
  portalChatLayout,
  portalChatShellClass,
} from "./chat-layout";
import { portalChatPath } from "./portal-home";
import { PortalNotificationBell } from "./PortalNotificationBell";
import { InfraBrand } from "../components/InfraBrand";
import type { PortalShellOutletContext } from "./PortalShell";
import {
  SafeMarkdown,
  extractEmailSummaryRows,
  finalActivitySteps,
  markdownToPlainText,
  mergeActivityStatus,
  type EmailSummaryRow,
  type PortalChatActivityStep,
} from "./safe-markdown";

const DRAFT_ID = "draft";
type HistoryFilter = "all" | "tools";

type ConnectorHighlight = {
  key: "mail" | "files" | "xero" | "mcp";
  label: string;
  detail: string;
  href: string;
  status: "connected" | "attention" | "available";
  statusLabel: string;
  prompt: string;
};

export default function PortalChatPage() {
  const { company, overview, loading, error } = usePortalCompany();
  const { conversationId: routeConversationId } = useParams();
  const navigate = useNavigate();
  const shellChrome = useOutletContext<PortalShellOutletContext>();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isTablet = useMediaQuery("(max-width: 1099px)");
  const layout = portalChatLayout(isMobile ? 390 : isTablet ? 900 : 1280);
  const [conversations, setConversations] = useState<PortalChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(routeConversationId === DRAFT_ID ? DRAFT_ID : routeConversationId ?? null);
  const [active, setActive] = useState<PortalChatConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ label: string; tool?: string | null } | null>(null);
  const [activitySteps, setActivitySteps] = useState<PortalChatActivityStep[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(!isMobile);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [drafting, setDrafting] = useState(!routeConversationId || routeConversationId === DRAFT_ID);
  const scroller = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);

  const messages = active?.messages ?? [];
  const currentDocument = active?.context?.currentDocument ?? null;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const visibleConversations = useMemo(() => {
    if (!active || !active.messages?.length || conversations.some((row) => row.id === active.id)) {
      return conversations;
    }
    const firstUser = active.messages.find((message) => message.role === "user");
    const last = active.messages.at(-1);
    return [
      {
        ...active,
        title: displayConversationTitle(active.title, firstUser?.content),
        lastMessagePreview: last?.content ? markdownToPlainText(last.content) : null,
        lastMessageAt: last?.createdAt ?? active.updatedAt,
        messageCount: active.messages.length,
      },
      ...conversations,
    ];
  }, [active, conversations]);
  const filteredConversations = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    return visibleConversations.filter((conversation) => {
      const hasTools = Boolean(
        conversation.messages?.some((message) => message.metadata.toolNames?.length) ||
          conversation.lastMessagePreview?.match(/\b(xero|outlook|mail|document|search)\b/i),
      );
      if (historyFilter === "tools" && !hasTools) return false;
      if (!query) return true;
      const haystack = [
        conversation.title,
        conversation.lastMessagePreview,
        ...(conversation.messages ?? []).map((message) => message.content),
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [historyFilter, historyQuery, visibleConversations]);
  const grouped = useMemo(() => groupConversations(filteredConversations), [filteredConversations]);
  const starterPrompts = useMemo(() => emptyStatePrompts(company?.name), [company?.name]);
  const connectorHighlights = useMemo(
    () => buildConnectorHighlights(overview, company?.slug ?? ""),
    [overview, company?.slug],
  );
  const connectedConnectorCount = connectorHighlights.filter((item) => item.status === "connected").length;
  const attentionConnectorCount = connectorHighlights.filter((item) => item.status === "attention").length;
  const firstDisconnectedConnector = connectorHighlights.find((item) => item.status !== "connected");

  async function refreshList(slug: string) {
    const response = await api.listPortalConversations(slug);
    setConversations(response.conversations);
    return response.conversations;
  }

  useEffect(() => {
    setHistoryOpen(!isMobile);
  }, [isMobile]);

  useEffect(() => {
    if (routeConversationId && routeConversationId !== DRAFT_ID) {
      setDrafting(false);
      setActiveId(routeConversationId);
      return;
    }
    setDrafting(true);
    setActiveId(DRAFT_ID);
    setActive(null);
  }, [routeConversationId]);

  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoadError(null);
        await refreshList(company.slug);
        if (cancelled) return;
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Unable to load chats");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company]);

  useEffect(() => {
    if (!company || !activeId || activeId === DRAFT_ID) {
      if (activeId === DRAFT_ID || drafting) {
        setActive(null);
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.getPortalConversation(company.slug, activeId);
        if (!cancelled) setActive(response.conversation);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Unable to open this chat");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company, activeId, drafting]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, status, busy]);

  function openConversation(id: string) {
    if (!company) return;
    setDrafting(false);
    setActiveId(id);
    if (isMobile) setHistoryOpen(false);
    navigate(portalChatPath(company.slug, id));
  }

  function startNewChat() {
    if (!company) return;
    setDrafting(true);
    setActiveId(DRAFT_ID);
    setActive(null);
    if (isMobile) setHistoryOpen(false);
    navigate(portalChatPath(company.slug), { replace: false });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function send(text = draft) {
    if (!company || busy) return;
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    const conversationId = drafting || !activeId || activeId === DRAFT_ID ? null : activeId;
    const optimistic: PortalChatMessage = {
      id: `local_${Date.now()}`,
      conversationId: conversationId ?? "pending",
      companyId: company.id,
      userId: "me",
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    setDraft("");
    setBusy(true);
    setStatus({ label: "Thinking…" });
    setActivitySteps([{ key: "thinking", label: "Thinking", detail: "Planning the safest way to answer.", status: "running" }]);
    stickToBottom.current = true;
    setActive((current) =>
      current
        ? { ...current, messages: [...(current.messages ?? []), optimistic] }
        : {
            id: conversationId ?? "pending",
            companyId: company.id,
            userId: "me",
            title: displayConversationTitle(trimmed, trimmed),
            createdAt: optimistic.createdAt,
            updatedAt: optimistic.createdAt,
            context: { currentDocument: null, recentDocuments: [] },
            messages: [optimistic],
          },
    );

    try {
      const result = await api.streamPortalChatMessage(company.slug, {
        conversationId,
        text: trimmed,
        onStatus: (event) => {
          setStatus(event);
          setActivitySteps((current) => mergeActivityStatus(current, event));
        },
      });
      applyTurn(result);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to send that message");
      setActive((current) =>
        current ? { ...current, messages: (current.messages ?? []).filter((message) => message.id !== optimistic.id) } : current,
      );
      setDraft(trimmed);
    } finally {
      setBusy(false);
      setStatus(null);
      setActivitySteps([]);
    }
  }

  function applyTurn(result: PortalChatTurnResult) {
    if (!company) return;
    setDrafting(false);
    setActiveId(result.conversation.id);
    setConversations((current) => {
      const next = current.filter((row) => row.id !== result.conversation.id);
      return [
        {
          ...result.conversation,
          title: displayConversationTitle(result.conversation.title, result.userMessage.content),
          lastMessagePreview: markdownToPlainText(result.assistantMessage.content),
          lastMessageAt: result.assistantMessage.createdAt,
          messageCount: (current.find((row) => row.id === result.conversation.id)?.messageCount ?? 0) + 2,
        },
        ...next,
      ];
    });
    setActive((current) => {
      const prior = (current?.messages ?? []).filter((message) => !message.id.startsWith("local_"));
      const withoutDup = prior.filter((message) => message.id !== result.userMessage.id && message.id !== result.assistantMessage.id);
      return {
        ...result.conversation,
        context: current?.context ?? { currentDocument: null, recentDocuments: [] },
        messages: [...withoutDup, result.userMessage, result.assistantMessage],
      };
    });
    setActivitySteps((current) => finalActivitySteps(current, result.assistantMessage.metadata.toolNames, result.assistantMessage.metadata.terminal));
    navigate(portalChatPath(company.slug, result.conversation.id), { replace: true });
    void refreshList(company.slug).catch(() => undefined);
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!company || !renameId) return;
    const updated = await api.renamePortalConversation(company.slug, renameId, renameValue);
    setConversations((current) => current.map((row) => (row.id === updated.conversation.id ? { ...row, ...updated.conversation } : row)));
    if (active?.id === updated.conversation.id) {
      setActive({ ...active, title: updated.conversation.title });
    }
    setRenameId(null);
  }

  const hints = useMemo(
    () =>
      followUpHints({
        hasDocument: Boolean(currentDocument || lastAssistant?.metadata.sources?.length),
        permissionDenied: Boolean(lastAssistant?.metadata.permissionDenied),
        controlledAction: Boolean(lastAssistant?.metadata.controlledAction),
      }),
    [currentDocument, lastAssistant],
  );

  if (loading) return <LoadingState label="Opening chat…" />;
  if (error || !company) return <ErrorState title="Chat unavailable" description={error ?? undefined} />;

  const sidebar = (
    <aside className="portal-chat-sidebar" aria-label="Recent chats">
      <div className="portal-chat-sidebar-head">
        <div>
          <strong>Chats</strong>
          <span>Shared company memory</span>
        </div>
        <div className="portal-chat-sidebar-actions">
          <Button type="button" size="sm" variant="primary" aria-label="Start a new chat" onClick={startNewChat}>
            <Plus size={16} /> New
          </Button>
          {!isMobile ? (
            <Button type="button" size="sm" variant="ghost" aria-label="Collapse chat history" onClick={() => setHistoryOpen(false)}>
              <ChevronLeft size={16} />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="portal-chat-sidebar-tools">
        <label className="portal-chat-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
            placeholder="Search chats, messages, tools..."
            aria-label="Search chats"
          />
        </label>
        <div className="portal-chat-filter-tabs" aria-label="Chat filters">
          <button
            type="button"
            className={historyFilter === "all" ? "is-active" : ""}
            aria-pressed={historyFilter === "all"}
            onClick={() => setHistoryFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            className={historyFilter === "tools" ? "is-active" : ""}
            aria-pressed={historyFilter === "tools"}
            onClick={() => setHistoryFilter("tools")}
          >
            Tool runs
          </button>
        </div>
      </div>
      {filteredConversations.length === 0 ? (
        <EmptyState
          title={visibleConversations.length ? "No matching chats" : active ? "Syncing chat history…" : "No chats yet"}
          description={
            visibleConversations.length
              ? "Try another search or clear the tool filter."
              : "Start a conversation with INFRA for this company."
          }
        />
      ) : (
        <div className="portal-chat-history" role="list">
          {grouped.map((group) => (
            <section key={group.key} className="portal-chat-group" aria-label={group.label}>
              <h3 className="portal-chat-group-label">{group.label}</h3>
              <ul>
                {group.items.map((row) => {
                  const selected = row.id === activeId && !drafting;
                  return (
                    <li key={row.id}>
                      {renameId === row.id ? (
                        <form className="portal-chat-rename" onSubmit={(event) => void submitRename(event)}>
                          <input
                            className="input"
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            aria-label="Chat title"
                            autoFocus
                          />
                          <Button type="submit" size="sm">
                            Save
                          </Button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className={`portal-chat-history-item${selected ? " is-active" : ""}`}
                          aria-current={selected ? "true" : undefined}
                          aria-label={row.title}
                          onClick={() => openConversation(row.id)}
                          onDoubleClick={() => {
                            setRenameId(row.id);
                            setRenameValue(row.title);
                          }}
                        >
                          <span className="portal-chat-history-title">{row.title}</span>
                          {row.lastMessagePreview ? (
                            <span className="portal-chat-history-preview">{markdownToPlainText(row.lastMessagePreview)}</span>
                          ) : null}
                          <span className="portal-chat-history-time">
                            {formatRelativeTime(row.lastMessageAt ?? row.updatedAt)}
                          </span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );

  return (
    <div className={portalChatShellClass(layout, historyOpen)}>
      {isMobile ? (
        <div className="portal-chat-mobile-bar">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Open portal navigation"
            aria-controls="portal-company-navigation"
            onClick={() => shellChrome.openMobileNav()}
          >
            <Menu size={18} />
          </Button>
          <div className="portal-chat-mobile-title">
            <InfraBrand compact size={26} />
            <div>
              <span>{company.name}</span>
              <strong>{historyOpen ? "Chats" : drafting ? "New chat" : active?.title ?? "Chat"}</strong>
            </div>
          </div>
          <div className="portal-chat-mobile-actions">
            <PortalNotificationBell variant="header" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={historyOpen ? "Close chat history" : "Open chat history"}
              aria-expanded={historyOpen}
              aria-controls="portal-chat-history-drawer"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {historyOpen ? <X size={18} /> : <PanelLeftOpen size={18} />}
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label="Start a new chat" onClick={startNewChat}>
              <Plus size={18} />
            </Button>
          </div>
        </div>
      ) : null}

      {isMobile && historyOpen ? (
        <div id="portal-chat-history-drawer" className="portal-chat-history-drawer">
          {sidebar}
        </div>
      ) : null}
      {!isMobile ? sidebar : null}

      <section className="portal-chat-main" aria-label="Active chat">
        <div className="portal-chat-main-head">
          <div className="portal-chat-title-block">
            <span className="portal-chat-eyebrow">INFRA workspace</span>
            <strong>{drafting ? `New chat with ${company.name}` : active?.title ?? `Chat with ${company.name}`}</strong>
            <span className="portal-chat-headline-meta">
              {connectedConnectorCount} connected system{connectedConnectorCount === 1 ? "" : "s"}
              {attentionConnectorCount ? ` · ${attentionConnectorCount} needs review` : " · approvals protected"}
            </span>
          </div>
          <div className="portal-chat-head-actions">
            <Link className="button button-secondary button-small" to={`/portal/${company.slug}/connectors`}>
              <Zap size={16} /> Connections
            </Link>
            {!isMobile && !historyOpen ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}>
                <PanelLeftOpen size={16} /> History
              </Button>
            ) : null}
          </div>
        </div>
        {loadError ? <ErrorState title="Chat error" description={loadError} onRetry={() => setLoadError(null)} /> : null}
        <div
          className="portal-chat-transcript"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          }}
        >
          {messages.length === 0 && !busy ? (
            <div className="portal-chat-hero">
              <div className="portal-chat-hero-copy">
                <div className="portal-chat-orb" aria-hidden="true">
                  <Sparkles size={28} />
                </div>
                <span className="portal-chat-hero-kicker">Company-aware AI for {company.name}</span>
                <h1>Ask INFRA to check, find, and prepare the next step.</h1>
                <p>
                  Search approved files, read connected mailboxes and finance systems, or ask INFRA to draft a safe action
                  plan for approval before anything changes.
                </p>
              </div>

              <ConnectorRail items={connectorHighlights} onPrompt={(prompt) => void send(prompt)} />

              <div className="portal-chat-starters" aria-label="Suggested prompts">
                {starterPrompts.map((prompt, index) => (
                  <button key={prompt} type="button" className="portal-chat-starter" onClick={() => void send(prompt)}>
                    {starterIcon(index)}
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>

              <div className="portal-chat-hero-cards" aria-label="Ways to work with INFRA">
                <div className="portal-chat-capability-card">
                  <MessageSquare size={18} />
                  <strong>Ask once, use every permitted source</strong>
                  <span>INFRA keeps RBAC, citations, and tool activity visible while it works through the request.</span>
                </div>
                <div className="portal-chat-capability-card">
                  <ShieldCheck size={18} />
                  <strong>Writes stay approval-first</strong>
                  <span>Xero or mailbox actions become approval tasks when a connected automation can safely continue.</span>
                </div>
                <div className="portal-chat-capability-card portal-chat-capability-card--muted">
                  <Bot size={18} />
                  <strong>Task agents</strong>
                  <span>Reusable assistants can be enabled from Automations as backend capability becomes available.</span>
                </div>
              </div>
            </div>
          ) : (
            messages.map((message) => <ChatBubble key={message.id} message={message} companySlug={company.slug} />)
          )}
          {busy ? (
            <ActivityTrail steps={activitySteps} liveLabel={status?.label || "Thinking…"} />
          ) : null}
        </div>

        {hints.length && !busy ? (
          <div className="portal-chat-followups">
            {hints.map((hint) =>
              hint.startsWith("Open approvals") ? (
                <Link key={hint} className="portal-chat-chip" to={`/portal/${company.slug}/actions`}>
                  {hint}
                </Link>
              ) : (
                <button key={hint} type="button" className="portal-chat-chip" onClick={() => void send(hint)}>
                  {hint}
                </button>
              ),
            )}
          </div>
        ) : null}

        <form
          className="portal-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="portal-chat-composer-context">
            <div className="portal-chat-composer-status">
              <span className={`portal-chat-status-dot-static${firstDisconnectedConnector ? "" : " is-ready"}`} aria-hidden="true" />
              <span>
                {firstDisconnectedConnector
                  ? `${firstDisconnectedConnector.label} not connected`
                  : `${connectedConnectorCount} systems ready`}
              </span>
            </div>
            <Link to={`/portal/${company.slug}/connectors`}>
              {firstDisconnectedConnector ? `Connect ${firstDisconnectedConnector.label}` : "Manage connections"}
            </Link>
          </div>
          <div className="portal-chat-composer-box">
            <textarea
              ref={inputRef}
              className="input portal-chat-input"
              rows={isMobile ? 1 : 3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask INFRA to check the inbox, search files, review Xero, or prepare an approval…"
              aria-label="Message INFRA"
              disabled={false}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!composerSendDisabled(busy, draft)) void send();
                }
              }}
            />
            <div className="portal-chat-composer-tools" aria-label="Composer context">
              <span title="Attachments are handled through connected file sources">
                <Paperclip size={16} aria-hidden="true" />
              </span>
              <span title="Writes require confirmation and approvals">
                <ShieldCheck size={16} aria-hidden="true" />
              </span>
            </div>
            <Button type="submit" variant="primary" disabled={composerSendDisabled(busy, draft)} aria-label="Send message">
              <Send size={16} /> {isMobile ? "" : "Send"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ChatBubble({ message, companySlug }: { message: PortalChatMessage; companySlug: string }) {
  const sources = message.metadata.sources?.filter((source) => source.url) ?? [];
  const tools = message.metadata.toolNames ?? [];
  const terminal = message.metadata.terminal ? terminalLabel(message.metadata.terminal) : null;
  const emailRows = message.role === "assistant" ? extractEmailSummaryRows(message.content) : [];
  const completedSteps = message.role === "assistant" ? finalActivitySteps([], tools, message.metadata.terminal) : [];
  return (
    <article className={`portal-chat-bubble portal-chat-bubble--${message.role}`}>
      <div className="portal-chat-bubble-meta">
        <span>{message.role === "assistant" ? "INFRA" : "You"}</span>
        {message.role === "assistant" && tools.length ? <span>{tools.length} tool step{tools.length === 1 ? "" : "s"}</span> : null}
      </div>
      <div className="portal-chat-bubble-body">
        {emailRows.length ? <EmailSummaryCards rows={emailRows} intro={emailIntro(message.content)} /> : <SafeMarkdown text={message.content} />}
      </div>
      {message.metadata.permissionDenied ? (
        <p className="portal-chat-note portal-chat-note--denied">This was blocked by your company permissions.</p>
      ) : null}
      {message.metadata.controlledAction ? (
        <p className="portal-chat-note">
          Changes go through <Link to={`/portal/${companySlug}/actions`}>Approvals</Link> first.
        </p>
      ) : null}
      {sources.length ? (
        <ul className="portal-chat-sources" aria-label="Sources">
          {sources.map((source) => (
            <li key={source.id}>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
              ) : (
                source.title
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {message.role === "assistant" && (terminal || tools.length > 0) ? (
        <ActivityTrail steps={completedSteps} compact terminal={terminal} />
      ) : null}
    </article>
  );
}

function ActivityTrail({
  steps,
  liveLabel,
  compact = false,
  terminal = null,
}: {
  steps: PortalChatActivityStep[];
  liveLabel?: string;
  compact?: boolean;
  terminal?: string | null;
}) {
  const visible = steps.length
    ? steps
    : [{ key: "thinking", label: liveLabel ?? "Thinking", detail: "Working through the next safe step.", status: "running" as const }];
  return (
    <div className={`portal-chat-activity${compact ? " portal-chat-activity--compact" : ""}`} role={compact ? undefined : "status"} aria-live={compact ? undefined : "polite"}>
      {visible.map((step) => (
        <div key={step.key} className={`portal-chat-activity-step is-${step.status}`}>
          <span className="portal-chat-status-dot" aria-hidden="true" />
          <span>
            <strong>{step.label}</strong>
            {!compact ? <small>{step.detail}</small> : null}
          </span>
        </div>
      ))}
      {terminal && compact ? <span className="portal-chat-meta-chip">{terminal}</span> : null}
    </div>
  );
}

function EmailSummaryCards({ rows, intro }: { rows: EmailSummaryRow[]; intro?: string | null }) {
  return (
    <div className="portal-chat-email-summary">
      {intro ? <SafeMarkdown text={intro} /> : <p>{rows.length === 1 ? "Email found:" : `${rows.length} emails found:`}</p>}
      <div className="portal-chat-email-rows">
        {rows.map((row, index) => (
          <div key={`${row.time ?? "email"}-${row.subject}-${index}`} className="portal-chat-email-row">
            {row.time ? <time>{row.time}</time> : null}
            <div>
              <strong>{row.subject}</strong>
              {row.from ? <span>From {row.from}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function emailIntro(content: string): string | null {
  const line = content
    .split(/\n+/)
    .map((item) => item.trim())
    .find((item) => item && !/^[-*]\s/.test(item) && !/^\*\*(subject|from|received):\*\*/i.test(item));
  return line ? line.replace(/:$/, "") : null;
}

function ConnectorRail({
  items,
  onPrompt,
}: {
  items: ConnectorHighlight[];
  onPrompt: (prompt: string) => void;
}) {
  return (
    <div className="portal-chat-connection-panel" aria-label="Connected systems">
      <div className="portal-chat-connection-panel-head">
        <div>
          <span>Connected context</span>
          <strong>Bring systems into the conversation</strong>
        </div>
        <Link to={items.find((item) => item.href.endsWith("/connectors"))?.href ?? items[0]?.href ?? "#"}>View all</Link>
      </div>
      <div className="portal-chat-connection-rail">
        {items.map((item) => (
          <article key={item.key} className={`portal-chat-connection-card is-${item.status}`}>
            <div className="portal-chat-connection-icon">{connectorIcon(item.key)}</div>
            <div className="portal-chat-connection-copy">
              <div>
                <strong>{item.label}</strong>
                <span>{item.statusLabel}</span>
              </div>
              <p>{item.detail}</p>
            </div>
            {item.status === "connected" ? (
              <button type="button" onClick={() => onPrompt(item.prompt)}>
                Ask
              </button>
            ) : (
              <Link to={item.href}>Connect</Link>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function buildConnectorHighlights(
  overview: CompanyOverview | null,
  companySlug: string,
): ConnectorHighlight[] {
  const base = companySlug ? `/portal/${companySlug}` : "/portal";
  return [
    connectorHighlight({
      key: "mail",
      label: "Mail",
      slugs: ["outlook-shared-mailbox", "microsoft-365"],
      overview,
      href: `${base}/microsoft-365`,
      connectedDetail: "Read selected shared mailboxes such as info@ through Microsoft 365.",
      disconnectedDetail: "Connect Microsoft 365 mailboxes to ask what arrived today.",
      prompt: "Check the info@ inbox today and show anything urgent.",
    }),
    connectorHighlight({
      key: "files",
      label: "Files",
      slugs: ["sharepoint", "onedrive", "google-drive", "microsoft-365"],
      overview,
      href: `${base}/connectors`,
      connectedDetail: "Search approved SharePoint, OneDrive, Drive, and knowledge sources.",
      disconnectedDetail: "Add a document source so INFRA can search company files.",
      prompt: "Search company files for the latest quote or job pack.",
    }),
    connectorHighlight({
      key: "xero",
      label: "Xero",
      slugs: ["xero"],
      overview,
      href: `${base}/connectors`,
      connectedDetail: "Read finance context and prepare approval-first accounting actions.",
      disconnectedDetail: "Connect Xero to answer account, invoice, and payment questions.",
      prompt: "Check Xero for overdue invoices and summarise the highest priority items.",
    }),
    connectorHighlight({
      key: "mcp",
      label: "Company MCP",
      slugs: [],
      overview,
      href: `${base}/ai-connections`,
      connectedDetail: "Company tools are available through the INFRA MCP gateway.",
      disconnectedDetail: "Enable AI access so approved tools can be used from chat.",
      prompt: "What connected systems and tools can I access?",
      connectedOverride: Boolean(overview?.mcpEnvironments?.length || overview?.readyForUse),
    }),
  ];
}

function connectorHighlight(input: {
  key: ConnectorHighlight["key"];
  label: string;
  slugs: string[];
  overview: CompanyOverview | null;
  href: string;
  connectedDetail: string;
  disconnectedDetail: string;
  prompt: string;
  connectedOverride?: boolean;
}): ConnectorHighlight {
  const definitions = CONNECTOR_CATALOGUE.filter((item) => input.slugs.includes(item.slug));
  const definitionIds = new Set(definitions.map((item) => item.id));
  const instances = input.overview?.connectorInstances.filter((instance) => definitionIds.has(instance.connectorDefinitionId)) ?? [];
  const connected = input.connectedOverride || instances.some(isCustomerConnectedConnector);
  const attention = instances.some((instance) => {
    const health = deriveConnectorCustomerHealth(instance);
    return health.label === "Attention needed" || health.label === "Error";
  });
  const status: ConnectorHighlight["status"] = connected ? (attention ? "attention" : "connected") : "available";
  const healthLabel = instances.find(isCustomerConnectedConnector)
    ? deriveConnectorCustomerHealth(instances.find(isCustomerConnectedConnector)!).label
    : null;
  return {
    key: input.key,
    label: input.label,
    href: input.href,
    prompt: input.prompt,
    status,
    statusLabel: connected ? (attention ? "Needs review" : healthLabel ?? "Connected") : "Connect",
    detail: connected
      ? input.connectedDetail
      : definitions[0]
        ? connectorOverviewDescription(definitions[0].id)
        : input.disconnectedDetail,
  };
}

function connectorIcon(key: ConnectorHighlight["key"]) {
  if (key === "mail") return <Inbox size={18} />;
  if (key === "files") return <FileSearch size={18} />;
  if (key === "xero") return <Landmark size={18} />;
  return <Zap size={18} />;
}

function starterIcon(index: number) {
  const icons = [
    <Inbox key="inbox" size={18} />,
    <FileSearch key="files" size={18} />,
    <Landmark key="xero" size={18} />,
    <CircleDashed key="access" size={18} />,
  ];
  return icons[index % icons.length];
}

function terminalLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
