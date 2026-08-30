import { CALENDAR_POLICY_SUMMARY } from "./config";
import type { GraphClient } from "./graph";
import type { AccessPolicy } from "./policy";
import { getUser } from "./directory";

export type CalendarEvent = {
  id: string;
  subject: string | null;
  start: string | null;
  end: string | null;
  location: string | null;
  organizer: string | null;
  attendees: string[];
  webLink: string | null;
  mailbox: string;
};

type GraphEvent = {
  id: string;
  subject?: string | null;
  start?: { dateTime?: string } | null;
  end?: { dateTime?: string } | null;
  location?: { displayName?: string } | null;
  organizer?: { emailAddress?: { address?: string } } | null;
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  webLink?: string | null;
};

function mapEvent(raw: GraphEvent, mailbox: string): CalendarEvent {
  return {
    id: raw.id,
    subject: raw.subject ?? null,
    start: raw.start?.dateTime ?? null,
    end: raw.end?.dateTime ?? null,
    location: raw.location?.displayName ?? null,
    organizer: raw.organizer?.emailAddress?.address ?? null,
    attendees: (raw.attendees ?? [])
      .map((a) => a.emailAddress?.address)
      .filter(Boolean) as string[],
    webLink: raw.webLink ?? null,
    mailbox,
  };
}

async function resolveAttendees(
  graph: GraphClient,
  attendees: string[]
): Promise<Array<{ emailAddress: { address: string; name?: string } }>> {
  const resolved: Array<{ emailAddress: { address: string; name?: string } }> = [];
  for (const attendee of attendees) {
    if (attendee.includes("@")) {
      resolved.push({ emailAddress: { address: attendee } });
      continue;
    }
    const user = await getUser(graph, attendee);
    if (user?.mail || user?.userPrincipalName) {
      resolved.push({
        emailAddress: {
          address: (user.mail ?? user.userPrincipalName)!,
          name: user.displayName ?? undefined,
        },
      });
    } else {
      resolved.push({ emailAddress: { address: attendee } });
    }
  }
  return resolved;
}

export async function searchEvents(
  graph: GraphClient,
  policy: AccessPolicy,
  input: { mailbox: string; query?: string; start?: string; end?: string; top?: number }
): Promise<{ events: CalendarEvent[]; policy: string }> {
  const mailbox = policy.assertCalendarMailbox(input.mailbox);
  const top = Math.min(input.top ?? 15, 40);
  const filters: string[] = [];
  if (input.start) filters.push(`start/dateTime ge '${input.start}'`);
  if (input.end) filters.push(`end/dateTime le '${input.end}'`);
  const filter = filters.length ? `&$filter=${encodeURIComponent(filters.join(" and "))}` : "";
  const search = input.query ? `&$search=${encodeURIComponent(`"${input.query}"`)}` : "";
  const page = await graph.get<{ value?: GraphEvent[] }>(
    `/users/${encodeURIComponent(mailbox)}/events?$select=id,subject,start,end,location,organizer,attendees,webLink&$top=${top}${filter}${search}`,
    search ? { headers: { ConsistencyLevel: "eventual" } } : undefined
  );
  return {
    events: (page.value ?? []).map((item) => mapEvent(item, mailbox)),
    policy: CALENDAR_POLICY_SUMMARY,
  };
}

export async function getEvent(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  eventId: string
): Promise<CalendarEvent> {
  const approved = policy.assertCalendarMailbox(mailbox);
  const raw = await graph.get<GraphEvent>(
    `/users/${encodeURIComponent(approved)}/events/${encodeURIComponent(eventId)}`
  );
  return mapEvent(raw, approved);
}

export async function createEvent(
  graph: GraphClient,
  policy: AccessPolicy,
  input: {
    mailbox: string;
    subject: string;
    start: string;
    end: string;
    attendees?: string[];
    location?: string;
    body?: string;
    timeZone?: string;
  }
): Promise<CalendarEvent> {
  const mailbox = policy.assertCalendarMailbox(input.mailbox);
  const attendees = await resolveAttendees(graph, input.attendees ?? []);
  const raw = await graph.post<GraphEvent>(`/users/${encodeURIComponent(mailbox)}/events`, {
    subject: input.subject,
    start: { dateTime: input.start, timeZone: input.timeZone ?? "Europe/London" },
    end: { dateTime: input.end, timeZone: input.timeZone ?? "Europe/London" },
    location: input.location ? { displayName: input.location } : undefined,
    body: input.body ? { contentType: "Text", content: input.body } : undefined,
    attendees,
  });
  return mapEvent(raw, mailbox);
}

export async function updateEvent(
  graph: GraphClient,
  policy: AccessPolicy,
  input: {
    mailbox: string;
    eventId: string;
    subject?: string;
    start?: string;
    end?: string;
    location?: string;
    attendees?: string[];
    timeZone?: string;
  }
): Promise<CalendarEvent> {
  const mailbox = policy.assertCalendarMailbox(input.mailbox);
  const body: Record<string, unknown> = {};
  if (input.subject) body.subject = input.subject;
  if (input.start) body.start = { dateTime: input.start, timeZone: input.timeZone ?? "Europe/London" };
  if (input.end) body.end = { dateTime: input.end, timeZone: input.timeZone ?? "Europe/London" };
  if (input.location) body.location = { displayName: input.location };
  if (input.attendees) body.attendees = await resolveAttendees(graph, input.attendees);
  const raw = await graph.patch<GraphEvent>(
    `/users/${encodeURIComponent(mailbox)}/events/${encodeURIComponent(input.eventId)}`,
    body
  );
  return raw.id ? mapEvent(raw, mailbox) : getEvent(graph, policy, mailbox, input.eventId);
}

export async function cancelEvent(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  eventId: string
): Promise<{ status: "cancelled"; mailbox: string; eventId: string }> {
  const approved = policy.assertCalendarMailbox(mailbox);
  await graph.delete(`/users/${encodeURIComponent(approved)}/events/${encodeURIComponent(eventId)}`);
  return { status: "cancelled", mailbox: approved, eventId };
}
