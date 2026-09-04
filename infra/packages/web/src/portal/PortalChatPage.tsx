import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { displayConversationTitle, groupConversations } from "@infra/shared";
import { Menu, MessageSquare, Plus, Send, X } from "lucide-react";
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
  followUpHints,
  linkifyChatText,
  portalChatLayout,
  portalChatShellClass,
} from "./chat-layout";
import { portalChatPath } from "./portal-home";

const DRAFT_ID = "draft";

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
  const [status, setStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(!isMobile);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [drafting, setDrafting] = useState(!routeConversationId || routeConversationId === DRAFT_ID);
  const scroller = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);

  const messages = active?.messages ?? [];
  const currentDocument = active?.context?.currentDocument ?? null;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const grouped = useMemo(() => groupConversations(conversations), [conversations]);

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
    setHistoryOpen(false);
    navigate(portalChatPath(company.slug, id));
  }

  function startNewChat() {
    if (!company) return;
    setDrafting(true);
    setActiveId(DRAFT_ID);
    setActive(null);
    setHistoryOpen(false);
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
    setStatus("Thinking…");
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
        onStatus: (event) => setStatus(event.label),
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
          lastMessagePreview: result.assistantMessage.content,
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
    navigate(portalChatPath(company.slug, result.conversation.id), { replace: true });
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
        <strong>Chats</strong>
        <Button type="button" size="sm" variant="primary" aria-label="Start a new chat" onClick={startNewChat}>
          <Plus size={16} /> New chat
        </Button>
      </div>
      {conversations.length === 0 ? (
        <EmptyState title="No chats yet" description="Start a conversation with INFRA for this company." />
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
                            <span className="portal-chat-history-preview">{row.lastMessagePreview}</span>
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
            <EmptyState
              icon={<MessageSquare size={28} />}
              title="Ask INFRA"
              description="Search files, check connected systems you can access, or pick up a previous chat."
            />
          ) : (
            messages.map((message) => <ChatBubble key={message.id} message={message} companySlug={company.slug} />)
          )}
          {busy ? (
            <div className="portal-chat-status" role="status" aria-live="polite">
              {status || "Thinking…"}
            </div>
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
          <textarea
            ref={inputRef}
            className="input portal-chat-input"
            rows={isMobile ? 2 : 3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message INFRA…"
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
  const parts = linkifyChatText(message.content);
  const sources = message.metadata.sources?.filter((source) => source.url) ?? [];
  return (
    <article className={`portal-chat-bubble portal-chat-bubble--${message.role}`}>
      <div className="portal-chat-bubble-body">
        {parts.map((part, index) =>
          part.type === "link" ? (
            <a key={`${part.value}-${index}`} href={part.value} target="_blank" rel="noreferrer">
              {part.value}
            </a>
          ) : (
            <span key={index}>{part.value}</span>
          ),
        )}
      </div>
      {message.metadata.permissionDenied ? (
        <p className="portal-chat-note">This was blocked by your company permissions.</p>
      ) : null}
      {message.metadata.controlledAction ? (
        <p className="portal-chat-note">
          Changes go through <Link to={`/portal/${companySlug}/actions`}>Approvals</Link> first.
        </p>
      ) : null}
      {sources.length ? (
        <ul className="portal-chat-sources">
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
    </article>
  );
}
