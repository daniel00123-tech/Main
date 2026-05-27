import { jobs, technicians } from '../data/mockData'

export function MapView() {
  return (
    <div data-testid="view-map" className="relative h-[calc(100vh-73px)] overflow-hidden">
      <div
        className="absolute inset-0 bg-[#0d1218]"
        style={{
          backgroundImage: `
            radial-gradient(circle at 30% 40%, rgba(59,158,255,0.08) 0%, transparent 50%),
            linear-gradient(rgba(30,42,56,0.4) 1px, transparent 1px),
            linear-gradient(90deg, rgba(30,42,56,0.4) 1px, transparent 1px)
          `,
          backgroundSize: '100% 100%, 48px 48px, 48px 48px',
        }}
      />
      <div className="absolute left-6 top-6 z-10 rounded-xl border border-bc-border bg-bc-panel/95 p-4 shadow-xl backdrop-blur">
        <h2 className="text-sm font-semibold">Live fleet — GPS</h2>
        <p className="mt-1 text-xs text-bc-muted">Auto clock-in on geofence entry</p>
        <ul className="mt-3 space-y-2 text-xs">
          {technicians.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  t.status === 'on_job'
                    ? 'bg-bc-success'
                    : t.status === 'traveling'
                      ? 'bg-bc-warning'
                      : 'bg-bc-accent'
                }`}
              />
              <span className="font-medium">{t.name}</span>
              <span className="text-bc-muted">— {t.status.replace('_', ' ')}</span>
            </li>
          ))}
        </ul>
      </div>
      {technicians.map((t, i) => (
        <div
          key={t.id}
          data-testid={`map-pin-${t.id}`}
          className="absolute flex flex-col items-center"
          style={{
            left: `${18 + i * 18}%`,
            top: `${28 + (i % 2) * 22}%`,
          }}
        >
          <div className="relative">
            <span className="absolute -inset-3 animate-ping rounded-full bg-bc-accent/20" />
            <div className="relative flex h-10 w-10 items-center justify-center rounded-full border-2 border-bc-accent bg-bc-panel text-xs font-bold shadow-lg shadow-bc-accent/30">
              {t.name
                .split(' ')
                .map((n) => n[0])
                .join('')}
            </div>
          </div>
          <span className="mt-1 rounded bg-bc-panel/90 px-2 py-0.5 text-[10px]">{t.name.split(' ')[0]}</span>
        </div>
      ))}
      {jobs
        .filter((j) => j.status === 'on_site' || j.status === 'en_route')
        .map((job, i) => (
          <div
            key={job.id}
            className="absolute rounded border border-bc-success/40 bg-bc-success/10 px-2 py-1 text-[10px]"
            style={{ left: `${55 + i * 8}%`, top: `${45 + i * 10}%` }}
          >
            📍 {job.reference}
          </div>
        ))}
    </div>
  )
}
