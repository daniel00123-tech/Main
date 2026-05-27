import { useState } from 'react'
import { threads } from '../data/mockData'

export function MessagesView() {
  const [active, setActive] = useState(threads[0])

  return (
    <div data-testid="view-messages" className="flex h-[calc(100vh-73px)]">
      <div className="w-72 shrink-0 border-r border-bc-border bg-bc-panel">
        <div className="border-b border-bc-border px-4 py-3 text-sm font-medium">
          Two-way messaging
        </div>
        <ul>
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                data-testid={`thread-${t.id}`}
                onClick={() => setActive(t)}
                className={`w-full border-b border-bc-border/50 px-4 py-3 text-left text-sm transition-colors hover:bg-white/5 ${
                  active.id === t.id ? 'bg-bc-accent/10' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.customer}</span>
                  {t.unread > 0 && (
                    <span className="rounded-full bg-bc-accent px-1.5 text-[10px] text-bc-bg">
                      {t.unread}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-bc-muted">{t.lastMessage}</p>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="border-b border-bc-border px-6 py-3">
          <div className="font-medium">{active.customer}</div>
          <div className="text-xs text-bc-muted">
            {active.channel.toUpperCase()} · appointment updates enabled
          </div>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-6">
          <div className="max-w-md rounded-2xl rounded-bl-sm bg-bc-panel px-4 py-2 text-sm">
            Good morning — your engineer is scheduled between 09:00 and 11:30 today.
          </div>
          <div className="ml-auto max-w-md rounded-2xl rounded-br-sm bg-bc-accent/20 px-4 py-2 text-sm">
            {active.lastMessage}
          </div>
          <div className="max-w-md rounded-2xl rounded-bl-sm bg-bc-panel px-4 py-2 text-sm text-bc-muted">
            [Automated] On our way alert sent when technician left previous job.
          </div>
        </div>
        <div className="border-t border-bc-border p-4">
          <input
            data-testid="message-compose"
            className="w-full rounded-lg border border-bc-border bg-bc-bg px-4 py-2 text-sm outline-none focus:border-bc-accent"
            placeholder="Reply to customer…"
            defaultValue=""
          />
        </div>
      </div>
    </div>
  )
}
