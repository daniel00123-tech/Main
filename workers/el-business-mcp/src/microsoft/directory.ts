import type { ElMicrosoftConfig } from "./config";
import type { GraphClient } from "./graph";
import { AccessPolicy, scoreProtectedCandidate, type ProtectedIdentity } from "./policy";

export type DirectoryUser = {
  id: string;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  accountEnabled?: boolean | null;
};

export type DirectoryGroup = {
  id: string;
  displayName: string | null;
  mail: string | null;
  description: string | null;
};

const USER_SELECT =
  "id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,accountEnabled";

function asUser(raw: Partial<DirectoryUser> & { id?: string }): DirectoryUser | null {
  if (!raw.id) return null;
  return {
    id: raw.id,
    displayName: raw.displayName ?? null,
    givenName: raw.givenName ?? null,
    surname: raw.surname ?? null,
    mail: raw.mail ?? null,
    userPrincipalName: raw.userPrincipalName ?? null,
    jobTitle: raw.jobTitle ?? null,
    accountEnabled: raw.accountEnabled ?? null,
  };
}

export async function listUsers(
  graph: GraphClient,
  query?: string,
  top = 25
): Promise<DirectoryUser[]> {
  if (query?.trim()) {
    const search = encodeURIComponent(`"${query.trim()}"`);
    const page = await graph.get<{ value?: Array<Partial<DirectoryUser>> }>(
      `/users?$search=${search}&$select=${USER_SELECT}&$top=${Math.min(top, 50)}`,
      { headers: { ConsistencyLevel: "eventual" } }
    );
    return (page.value ?? []).map(asUser).filter((user): user is DirectoryUser => Boolean(user));
  }
  const users = await graph.getAll<Partial<DirectoryUser>>(
    `/users?$select=${USER_SELECT}&$top=100`,
    10
  );
  return users.map(asUser).filter((user): user is DirectoryUser => Boolean(user));
}

export async function getUser(graph: GraphClient, idOrMail: string): Promise<DirectoryUser | null> {
  try {
    const raw = await graph.get<Partial<DirectoryUser>>(
      `/users/${encodeURIComponent(idOrMail)}?$select=${USER_SELECT}`
    );
    return asUser(raw);
  } catch {
    return null;
  }
}

export async function listGroups(graph: GraphClient, query?: string): Promise<DirectoryGroup[]> {
  const path = query?.trim()
    ? `/groups?$search=${encodeURIComponent(`"displayName:${query.trim()}"`)}&$select=id,displayName,mail,description&$top=25`
    : `/groups?$select=id,displayName,mail,description&$top=50`;
  const page = await graph.get<{ value?: DirectoryGroup[] }>(path, {
    headers: { ConsistencyLevel: "eventual" },
  });
  return page.value ?? [];
}

export async function resolveProtectedUsers(
  graph: GraphClient,
  config: ElMicrosoftConfig,
  policy: AccessPolicy
): Promise<ProtectedIdentity[]> {
  const resolved: ProtectedIdentity[] = [];
  const directory = await listUsers(graph);

  for (const hint of config.protectedUserHints) {
    const ranked = directory
      .map((user) => ({ user, score: scoreProtectedCandidate(user, hint) }))
      .filter((entry) => entry.score >= 50)
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.user;
    if (!best) {
      policy.markHintUnresolved(hint);
      continue;
    }

    let driveId: string | null = null;
    try {
      const drive = await graph.get<{ id?: string }>(`/users/${best.id}/drive?$select=id`);
      driveId = drive.id ?? null;
    } catch {
      driveId = null;
    }

    const identity: ProtectedIdentity = {
      id: best.id,
      displayName: best.displayName,
      mail: best.mail,
      userPrincipalName: best.userPrincipalName,
      givenName: best.givenName,
      matchedHint: hint,
      driveId,
    };
    policy.registerProtected(identity);
    resolved.push(identity);
  }

  return resolved;
}

export async function loadPolicy(
  graph: GraphClient,
  config: ElMicrosoftConfig
): Promise<AccessPolicy> {
  const policy = new AccessPolicy(config);
  await resolveProtectedUsers(graph, config, policy);
  return policy;
}
