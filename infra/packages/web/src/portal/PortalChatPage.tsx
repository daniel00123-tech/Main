import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { displayConversationTitle, groupConversations } from "@infra/shared";
import { Bot, ChevronLeft, Menu, MessageSquare, PanelLeftOpen, Plus, Search, Send, Sparkles, X } from "lucide-react";
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

export default function PortalChatPage() {
  const { company, loading, error } = usePortalCompany();
  const { conversationId: routeConversationId } = useParams();
  const navigate = useNavigate();
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
            aria-label={historyOpen ? "Close chat history" : "Open chat history"}
            aria-expanded={historyOpen}
            aria-controls="portal-chat-history-drawer"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            {historyOpen ? <X size={18} /> : <Menu size={18} />}
          </Button>
          <strong>{drafting ? "New chat" : active?.title ?? "Chat"}</strong>
          <Button type="button" variant="ghost" size="sm" aria-label="Start a new chat" onClick={startNewChat}>
            <Plus size={18} />
          </Button>
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
            <span className="portal-chat-eyebrow">INFRA chat</span>
            <strong>{drafting ? `New chat with ${company.name}` : active?.title ?? `Chat with ${company.name}`}</strong>
          </div>
          {!isMobile && !historyOpen ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}>
              <PanelLeftOpen size={16} /> History
            </Button>
          ) : null}
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
              <div className="portal-chat-orb" aria-hidden="true">
                <Sparkles size={28} />
              </div>
              <span className="portal-chat-hero-kicker">Company-aware assistant</span>
              <h1>What should we work out for {company.name}?</h1>
              <p>
                Ask INFRA to search files, check connected read-only systems, explain what you can access, or continue a
                previous thread.
              </p>
              <div className="portal-chat-starters" aria-label="Suggested prompts">
                {starterPrompts.map((prompt) => (
                  <button key={prompt} type="button" className="portal-chat-starter" onClick={() => void send(prompt)}>
                    <MessageSquare size={16} />
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>
              <div className="portal-chat-hero-cards" aria-label="Ways to work with INFRA">
                <div className="portal-chat-capability-card">
                  <MessageSquare size={18} />
                  <strong>Chat with connected context</strong>
                  <span>Ask questions across approved files, mailboxes, accounting, and company tools.</span>
                </div>
                <div className="portal-chat-capability-card portal-chat-capability-card--muted">
                  <Bot size={18} />
                  <strong>Task agents are next</strong>
                  <span>Future sidebar bots can attach APIs from the UI without backend-only wiring.</span>
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
          <div className="portal-chat-composer-label">
            <span>Message INFRA</span>
            <span>Shift+Enter for a new line</span>
          </div>
          <textarea
            ref={inputRef}
            className="input portal-chat-input"
            rows={isMobile ? 2 : 4}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about files, Xero, inboxes, approvals, or what you can access…"
            aria-label="Message INFRA"
            disabled={false}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!composerSendDisabled(busy, draft)) void send();
              }
            }}
          />
          <Button type="submit" variant="primary" disabled={composerSendDisabled(busy, draft)} aria-label="Send message">
            <Send size={16} /> {isMobile ? "" : "Send"}
          </Button>
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

function terminalLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
