import { jobs, technicians } from '../data/mockData'

const statusColor: Record<string, string> = {
  scheduled: 'bg-bc-accent/30 border-bc-accent/50',
  en_route: 'bg-bc-warning/25 border-bc-warning/50',
  on_site: 'bg-bc-success/25 border-bc-success/50',
  at_risk: 'bg-bc-danger/25 border-bc-danger/50',
  completed: 'bg-white/10 border-white/20',
}

export function PlannerView() {
  const hours = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']

  return (
    <div data-testid="view-planner" className="overflow-auto p-6">
      <div className="min-w-[720px] rounded-xl border border-bc-border bg-bc-panel">
        <div className="grid grid-cols-[140px_repeat(9,1fr)] border-b border-bc-border text-[10px] text-bc-muted">
          <div className="p-2" />
          {hours.map((h) => (
            <div key={h} className="border-l border-bc-border p-2 text-center">
              {h}
            </div>
          ))}
        </div>
        {technicians.map((tech) => {
          const techJobs = jobs.filter((j) => j.technicianId === tech.id)
          return (
            <div
              key={tech.id}
              className="relative grid grid-cols-[140px_repeat(9,1fr)] border-b border-bc-border last:border-0"
              style={{ minHeight: 72 }}
            >
              <div className="border-r border-bc-border p-3">
                <div className="text-sm font-medium">{tech.name}</div>
                <div className="text-[10px] text-bc-muted">{tech.role}</div>
              </div>
              {hours.map((h) => (
                <div key={h} className="border-l border-bc-border/50" />
              ))}
              {techJobs.map((job, idx) => (
                <div
                  key={job.id}
                  data-testid={`planner-job-${job.reference}`}
                  className={`absolute top-2 bottom-2 flex flex-col justify-center rounded-md border px-2 text-[10px] leading-tight ${statusColor[job.status]}`}
                  style={{
                    left: `calc(140px + ${(idx % 3) * 12}% )`,
                    width: '18%',
                    marginLeft: idx * 4,
                  }}
                >
                  <span className="font-semibold">{job.reference}</span>
                  <span className="truncate opacity-80">{job.type}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-bc-muted">
        Drag-and-drop scheduling would connect to BigChange JobWatch in production.
      </p>
    </div>
  )
}
