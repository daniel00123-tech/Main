import { agents, jobs, kpis, technicians } from '../data/mockData'

const toneClass = {
  neutral: 'text-bc-muted',
  success: 'text-bc-success',
  warning: 'text-bc-warning',
}

export function DashboardView() {
  const atRisk = jobs.filter((j) => j.status === 'at_risk')
  const onSite = jobs.filter((j) => j.status === 'on_site')

  return (
    <div data-testid="view-dashboard" className="space-y-6 p-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-xl border border-bc-border bg-bc-panel p-4 shadow-sm"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-bc-muted">
              {kpi.label}
            </div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{kpi.value}</div>
            <div className={`mt-1 text-xs ${toneClass[kpi.tone]}`}>{kpi.delta}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-bc-border bg-bc-panel">
          <div className="border-b border-bc-border px-4 py-3 text-sm font-medium">
            Today&apos;s operations
          </div>
          <div className="divide-y divide-bc-border">
            {onSite.concat(atRisk).map((job) => (
              <div key={job.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    job.status === 'at_risk' ? 'bg-bc-danger animate-pulse-dot' : 'bg-bc-success'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{job.reference}</div>
                  <div className="truncate text-bc-muted">
                    {job.customer} — {job.type}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-bc-muted">
                  {technicians.find((t) => t.id === job.technicianId)?.name.split(' ')[0]}
                </span>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-[10px] uppercase ${
                    job.status === 'at_risk'
                      ? 'bg-bc-danger/15 text-bc-danger'
                      : 'bg-bc-success/15 text-bc-success'
                  }`}
                >
                  {job.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-bc-border bg-bc-panel">
          <div className="border-b border-bc-border px-4 py-3 text-sm font-medium">
            AI agents — live
          </div>
          <ul className="divide-y divide-bc-border">
            {agents.slice(0, 4).map((agent) => (
              <li key={agent.id} className="px-4 py-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white/90">{agent.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] ${
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
                <p className="mt-1 text-bc-muted">{agent.lastAction}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
