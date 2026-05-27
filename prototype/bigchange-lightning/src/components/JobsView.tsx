import { useState } from 'react'
import { jobs, technicians } from '../data/mockData'
import type { Job } from '../types'

const statusLabel: Record<string, string> = {
  scheduled: 'Scheduled',
  en_route: 'En route',
  on_site: 'On site',
  completed: 'Completed',
  at_risk: 'At risk',
}

export function JobsView() {
  const [selected, setSelected] = useState<Job | null>(jobs[0])

  return (
    <div data-testid="view-jobs" className="flex h-[calc(100vh-73px)]">
      <div className="flex-1 overflow-auto p-6">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-bc-border text-xs text-bc-muted">
              <th className="pb-2 font-medium">Reference</th>
              <th className="pb-2 font-medium">Customer</th>
              <th className="pb-2 font-medium">Type</th>
              <th className="pb-2 font-medium">Technician</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Window</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr
                key={job.id}
                data-testid={`job-row-${job.reference}`}
                onClick={() => setSelected(job)}
                className={`cursor-pointer border-b border-bc-border/60 transition-colors hover:bg-white/5 ${
                  selected?.id === job.id ? 'bg-bc-accent/10' : ''
                }`}
              >
                <td className="py-3 font-medium text-bc-accent">{job.reference}</td>
                <td className="py-3">{job.customer}</td>
                <td className="py-3 text-bc-muted">{job.type}</td>
                <td className="py-3">
                  {technicians.find((t) => t.id === job.technicianId)?.name}
                </td>
                <td className="py-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      job.status === 'at_risk'
                        ? 'bg-bc-danger/15 text-bc-danger'
                        : 'bg-white/5 text-bc-muted'
                    }`}
                  >
                    {statusLabel[job.status]}
                  </span>
                </td>
                <td className="py-3 text-bc-muted">
                  {job.scheduledStart} – {job.scheduledEnd}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <aside
          data-testid="job-detail-panel"
          className="w-80 shrink-0 animate-slide-up border-l border-bc-border bg-bc-panel p-5"
        >
          <h2 className="text-lg font-semibold">{selected.reference}</h2>
          <p className="text-sm text-bc-muted">{selected.customer}</p>
          <dl className="mt-4 space-y-2 text-sm">
            <div>
              <dt className="text-xs text-bc-muted">Site</dt>
              <dd>{selected.site}</dd>
            </div>
            <div>
              <dt className="text-xs text-bc-muted">JobReady brief</dt>
              <dd className="rounded-lg border border-bc-border bg-bc-bg p-2 text-xs leading-relaxed text-bc-muted">
                {selected.materialsReady
                  ? 'Materials confirmed. Site history: 2 prior visits, last boiler service 11 months ago.'
                  : '⚠ Missing AHU filters on van stock — reorder or reschedule to avoid return visit.'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-bc-muted">GPS time</dt>
              <dd className="text-bc-success">
                {selected.status === 'on_site' ? 'Clocked in 09:08 (auto GPS)' : 'Not on site'}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="mt-4 w-full rounded-lg bg-bc-accent py-2 text-sm font-medium text-bc-bg"
          >
            Open in JobWatch
          </button>
        </aside>
      )}
    </div>
  )
}
