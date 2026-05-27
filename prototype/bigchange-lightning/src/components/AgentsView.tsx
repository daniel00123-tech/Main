import { agents } from '../data/mockData'

export function AgentsView() {
  return (
    <div data-testid="view-agents" className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <article
          key={agent.id}
          data-testid={`agent-card-${agent.id}`}
          className="rounded-xl border border-bc-border bg-bc-panel p-5 transition-shadow hover:shadow-lg hover:shadow-bc-accent/5"
        >
          <div className="flex items-start justify-between">
            <h3 className="text-lg font-semibold">{agent.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
                agent.status === 'active'
                  ? 'bg-bc-success/15 text-bc-success'
                  : agent.status === 'processing'
                    ? 'bg-bc-warning/15 text-bc-warning'
                    : 'bg-white/5 text-bc-muted'
              }`}
            >
              {agent.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-bc-accent">{agent.role}</p>
          <p className="mt-4 text-xs leading-relaxed text-bc-muted">{agent.lastAction}</p>
          <button
            type="button"
            className="mt-4 text-xs font-medium text-bc-accent hover:underline"
          >
            View activity log →
          </button>
        </article>
      ))}
      <article className="rounded-xl border border-dashed border-bc-border bg-bc-bg/50 p-5 sm:col-span-2 xl:col-span-3">
        <h3 className="text-sm font-medium">Platform features</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-bc-border p-3 text-xs">
            <strong className="text-white/90">Two-way messaging</strong>
            <p className="mt-1 text-bc-muted">
              SMS and email in one thread — on-the-way alerts, confirmations, no separate app.
            </p>
          </div>
          <div className="rounded-lg border border-bc-border p-3 text-xs">
            <strong className="text-white/90">GPS time tracking</strong>
            <p className="mt-1 text-bc-muted">
              Geofence prompts on arrival and departure — payroll accuracy and T&amp;M margin protection.
            </p>
          </div>
        </div>
      </article>
    </div>
  )
}
