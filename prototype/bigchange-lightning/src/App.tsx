import { useState } from 'react'
import { AgentsView } from './components/AgentsView'
import { DashboardView } from './components/DashboardView'
import { JobsView } from './components/JobsView'
import { JustAskView } from './components/JustAskView'
import { MapView } from './components/MapView'
import { MessagesView } from './components/MessagesView'
import { PlannerView } from './components/PlannerView'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import type { ViewId } from './types'

const titles: Record<ViewId, { title: string; subtitle?: string }> = {
  dashboard: { title: 'Operations dashboard', subtitle: 'Real-time KPIs and agent activity' },
  planner: { title: 'Resource planner', subtitle: 'Technician schedules — today' },
  jobs: { title: 'Jobs', subtitle: 'JobWatch-style job list and site briefs' },
  map: { title: 'Live map', subtitle: 'GPS tracking and geofenced time' },
  messages: { title: 'Customer messaging', subtitle: 'Two-way SMS and email' },
  justask: { title: 'JustAsk', subtitle: 'Ask your business anything' },
  agents: { title: 'AI agents', subtitle: 'FieldReady · JobReady · JobScribe · JobBrief' },
}

function App() {
  const [view, setView] = useState<ViewId>('dashboard')
  const navigate = (id: ViewId) => setView(id)

  const meta = titles[view]

  return (
    <div className="flex h-full min-h-screen bg-bc-bg" data-testid="app-root">
      <Sidebar active={view} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={meta.title} subtitle={meta.subtitle} />
        <main className="flex-1 overflow-auto">
          {view === 'dashboard' && <DashboardView />}
          {view === 'planner' && <PlannerView />}
          {view === 'jobs' && <JobsView />}
          {view === 'map' && <MapView />}
          {view === 'messages' && <MessagesView />}
          {view === 'justask' && <JustAskView />}
          {view === 'agents' && <AgentsView />}
        </main>
      </div>
    </div>
  )
}

export default App
