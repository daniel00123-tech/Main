import { companyName } from '../data/mockData'

interface TopBarProps {
  title: string
  subtitle?: string
}

export function TopBar({ title, subtitle }: TopBarProps) {
  return (
    <header
      data-testid="top-bar"
      className="flex items-center justify-between border-b border-bc-border bg-bc-panel/80 px-6 py-4 backdrop-blur"
    >
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-bc-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-4">
        <div className="hidden text-right text-xs text-bc-muted sm:block">
          <div className="font-medium text-white/90">{companyName}</div>
          <div>Wed 27 May 2026 · London</div>
        </div>
        <button
          type="button"
          className="rounded-lg border border-bc-border bg-bc-bg px-3 py-1.5 text-xs text-bc-muted hover:border-bc-accent/40"
        >
          + New job
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-bc-accent/20 text-sm font-medium text-bc-accent">
          AO
        </div>
      </div>
    </header>
  )
}
