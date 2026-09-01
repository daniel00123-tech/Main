import type { AgentCard, Job, MessageThread, Technician } from '../types'

export const companyName = 'Aquilo Facilities Ltd'

export const kpis = [
  { label: 'Jobs today', value: '24', delta: '+3 vs yesterday', tone: 'neutral' as const },
  { label: 'First-time fix', value: '87%', delta: '+6% this month', tone: 'success' as const },
  { label: 'Overdue invoices', value: '£12.4k', delta: '4 accounts', tone: 'warning' as const },
  { label: 'Active technicians', value: '9 / 11', delta: '2 on break', tone: 'neutral' as const },
]

export const technicians: Technician[] = [
  { id: 't1', name: 'James Okonkwo', role: 'Gas Safe Engineer', status: 'on_job', lat: 51.515, lng: -0.12, jobsToday: 4 },
  { id: 't2', name: 'Sarah Mitchell', role: 'Drainage Specialist', status: 'traveling', lat: 51.48, lng: -0.09, jobsToday: 3 },
  { id: 't3', name: 'Tom Hughes', role: 'HVAC Technician', status: 'available', lat: 51.5, lng: -0.15, jobsToday: 2 },
  { id: 't4', name: 'Priya Shah', role: 'Electrical', status: 'on_job', lat: 51.52, lng: -0.08, jobsToday: 5 },
]

export const jobs: Job[] = [
  {
    id: 'j1',
    reference: 'JOB-28491',
    customer: 'Westfield Retail Park',
    site: 'Unit 14, Shepherd\'s Bush',
    type: 'Boiler service',
    technicianId: 't1',
    status: 'on_site',
    scheduledStart: '09:00',
    scheduledEnd: '11:30',
    priority: 'normal',
    firstTimeFix: true,
    materialsReady: true,
  },
  {
    id: 'j2',
    reference: 'JOB-28492',
    customer: 'Harbour Apartments',
    site: 'Docklands E14',
    type: 'Blocked drain — emergency',
    technicianId: 't2',
    status: 'en_route',
    scheduledStart: '10:15',
    scheduledEnd: '12:00',
    priority: 'urgent',
    materialsReady: true,
  },
  {
    id: 'j3',
    reference: 'JOB-28493',
    customer: 'St. Mary\'s Hospital — Estates',
    site: 'Wing B, Level 3',
    type: 'AHU filter replacement',
    technicianId: 't3',
    status: 'scheduled',
    scheduledStart: '13:00',
    scheduledEnd: '16:00',
    priority: 'normal',
    materialsReady: false,
  },
  {
    id: 'j4',
    reference: 'JOB-28494',
    customer: 'Premier Hotels Group',
    site: 'Kensington Court',
    type: 'PAT testing — 42 items',
    technicianId: 't4',
    status: 'on_site',
    scheduledStart: '08:30',
    scheduledEnd: '14:00',
    priority: 'normal',
    firstTimeFix: true,
    materialsReady: true,
  },
  {
    id: 'j5',
    reference: 'JOB-28495',
    customer: 'City Council — Housing',
    site: 'Flat 7, Maple Street',
    type: 'Repeat visit — heating',
    technicianId: 't1',
    status: 'at_risk',
    scheduledStart: '14:30',
    scheduledEnd: '16:00',
    priority: 'urgent',
    firstTimeFix: false,
    materialsReady: false,
  },
]

export const threads: MessageThread[] = [
  { id: 'm1', customer: 'Westfield Retail Park', lastMessage: 'Technician has arrived on site.', time: '09:12', unread: 0, channel: 'sms' },
  { id: 'm2', customer: 'Harbour Apartments', lastMessage: 'On our way — ETA 15 minutes.', time: '10:02', unread: 1, channel: 'sms' },
  { id: 'm3', customer: 'Premier Hotels Group', lastMessage: 'Please confirm completion certificate.', time: 'Yesterday', unread: 2, channel: 'email' },
]

export const agents: AgentCard[] = [
  { id: 'justask', name: 'JustAsk', role: 'Platform intelligence', status: 'active', lastAction: 'Answered margin query 2m ago' },
  { id: 'fieldready', name: 'FieldReady', role: 'Training agent', status: 'idle', lastAction: 'Onboarded Tom Hughes — HVAC checklist' },
  { id: 'jobready', name: 'JobReady', role: 'Job preparation', status: 'processing', lastAction: 'Briefing JOB-28493 — missing filters flagged' },
  { id: 'jobscribe', name: 'JobScribe', role: 'Documentation', status: 'active', lastAction: 'Transcribing site notes — JOB-28491' },
  { id: 'jobbrief', name: 'JobBrief', role: 'Customer briefing', status: 'idle', lastAction: 'Sent summary to Premier Hotels' },
]

export const justAskSuggestions = [
  'What is our margin by technician this month?',
  'Which customers have not been visited in 90 days?',
  'Show overdue invoices over £1,000',
]

export const justAskResponses: Record<string, string> = {
  default:
    'Across your active technicians this month, blended gross margin is **34.2%**. James Okonkwo leads at **41.1%** (12 jobs, £18.2k revenue). The at-risk job JOB-28495 is dragging Sarah Mitchell\'s week — a second visit is likely without filter stock.',
  margin:
    '**Margin by technician (May 2026, ex-VAT):**\n\n• James Okonkwo — 41.1% (£18.2k)\n• Priya Shah — 38.6% (£22.1k)\n• Sarah Mitchell — 29.4% (£14.8k) — 2 return visits\n• Tom Hughes — 36.2% (£9.6k)\n\nRecommendation: reassign JOB-28495 prep to JobReady before dispatch.',
  customers:
    '**14 commercial accounts** have had no completed visit in 90+ days. Top risk: City Council Housing (last visit 112 days), Maple Street block. Suggested action: schedule proactive heating checks — 6 sites match your gas-safe capacity next week.',
  invoices:
    '**4 overdue invoices** totalling **£12,420** (ex-VAT):\n\n• Premier Hotels — £4,200 (32 days)\n• Westfield Retail — £3,100 (18 days)\n• Harbour Apartments — £2,620 (45 days)\n• St. Mary\'s Estates — £2,500 (12 days)\n\nJobBrief can send payment reminders with completion certificates attached.',
}
