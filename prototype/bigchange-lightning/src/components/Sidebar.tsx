import type { ViewId } from '../types'

const nav: { id: ViewId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◫' },
  { id: 'planner', label: 'Planner', icon: '▦' },
  { id: 'jobs', label: 'Jobs', icon: '☰' },
  { id: 'map', label: 'Live map', icon: '◎' },
  { id: 'messages', label: 'Messages', icon: '✉' },
  { id: 'justask', label: 'JustAsk', icon: '⚡' },
  { id: 'agents', label: 'AI agents', icon: '◇' },
]

interface SidebarProps {
  active: ViewId
  onNavigate: (id: ViewId) => void
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <aside
      data-testid="sidebar"
      className="flex w-56 shrink-0 flex-col border-r border-bc-border bg-bc-panel"
    >
      <div className="flex items-center gap-2 border-b border-bc-border px-4 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-bc-accent text-lg font-bold text-bc-bg">
          ⚡
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">Lightning</div>
          <div className="text-[10px] uppercase tracking-wider text-bc-muted">Field service</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`nav-${item.id}`}
            onClick={() => onNavigate(item.id)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
              active === item.id
                ? 'bg-bc-accent/15 text-bc-accent'
                : 'text-bc-muted hover:bg-white/5 hover:text-white'
            }`}
          >
            <span className="w-5 text-center text-base opacity-80">{item.icon}</span>
            {item.label}
            {item.id === 'justask' && (
              <span className="ml-auto rounded bg-bc-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-bc-accent">
                AI
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="border-t border-bc-border p-3 text-[11px] text-bc-muted">
        Prototype · mock data only
      </div>
    </aside>
  )
}
