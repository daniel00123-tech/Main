import { useState } from 'react'
import { justAskResponses, justAskSuggestions } from '../data/mockData'
import type { ChatMessage } from '../types'

function formatAnswer(text: string) {
  return text.split('\n').map((line, i) => (
    <span key={i}>
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
        part.startsWith('**') ? (
          <strong key={j} className="font-semibold text-white">
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
      {i < text.split('\n').length - 1 && <br />}
    </span>
  ))
}

export function JustAskView() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        "I'm Cooper — your JustAsk assistant. Ask anything about margins, jobs, invoices, or customer history.",
    },
  ])
  const [thinking, setThinking] = useState(false)

  const submit = (query: string) => {
    if (!query.trim()) return
    setMessages((m) => [...m, { role: 'user', content: query }])
    setInput('')
    setThinking(true)
    const key = query.toLowerCase().includes('margin')
      ? 'margin'
      : query.toLowerCase().includes('90')
        ? 'customers'
        : query.toLowerCase().includes('invoice')
          ? 'invoices'
          : 'default'
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: justAskResponses[key] ?? justAskResponses.default },
      ])
      setThinking(false)
    }, 900)
  }

  return (
    <div data-testid="view-justask" className="flex h-[calc(100vh-73px)] flex-col p-6">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col rounded-2xl border border-bc-border bg-bc-panel shadow-2xl">
        <div className="border-b border-bc-border px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <div>
              <h2 className="font-semibold">JustAsk</h2>
              <p className="text-xs text-bc-muted">Platform intelligence · plain-language answers</p>
            </div>
          </div>
        </div>
        <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              data-testid={msg.role === 'assistant' ? 'justask-reply' : 'justask-user-msg'}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-bc-accent text-bc-bg'
                    : 'border border-bc-border bg-bc-bg'
                }`}
              >
                {msg.role === 'assistant' ? formatAnswer(msg.content) : msg.content}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="text-sm text-bc-muted" data-testid="justask-thinking">
              Cooper is analysing your data…
            </div>
          )}
        </div>
        <div className="border-t border-bc-border p-4">
          <div className="mb-2 flex flex-wrap gap-2">
            {justAskSuggestions.map((s) => (
              <button
                key={s}
                type="button"
                data-testid="justask-suggestion"
                onClick={() => submit(s)}
                className="rounded-full border border-bc-border px-3 py-1 text-[11px] text-bc-muted hover:border-bc-accent/50 hover:text-bc-accent"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit(input)
            }}
            className="flex gap-2"
          >
            <input
              data-testid="justask-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="flex-1 rounded-xl border border-bc-border bg-bc-bg px-4 py-3 text-sm outline-none focus:border-bc-accent"
              placeholder="Ask anything about your business…"
            />
            <button
              type="submit"
              data-testid="justask-submit"
              className="rounded-xl bg-bc-accent px-5 py-3 text-sm font-medium text-bc-bg"
            >
              Ask
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
