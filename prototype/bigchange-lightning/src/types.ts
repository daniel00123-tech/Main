export type ViewId =
  | 'dashboard'
  | 'planner'
  | 'jobs'
  | 'map'
  | 'messages'
  | 'justask'
  | 'agents'

export type JobStatus = 'scheduled' | 'en_route' | 'on_site' | 'completed' | 'at_risk'

export interface Technician {
  id: string
  name: string
  role: string
  status: 'available' | 'on_job' | 'traveling' | 'offline'
  lat: number
  lng: number
  jobsToday: number
}

export interface Job {
  id: string
  reference: string
  customer: string
  site: string
  type: string
  technicianId: string
  status: JobStatus
  scheduledStart: string
  scheduledEnd: string
  priority: 'normal' | 'urgent'
  firstTimeFix?: boolean
  materialsReady?: boolean
}

export interface MessageThread {
  id: string
  customer: string
  lastMessage: string
  time: string
  unread: number
  channel: 'sms' | 'email'
}

export interface AgentCard {
  id: string
  name: string
  role: string
  status: 'active' | 'idle' | 'processing'
  lastAction: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
