import type { Env } from "../env";
import { createMicrosoftContext } from "./context";
import { ElMicrosoftError } from "./errors";
import { listEligibleOneDrives } from "./files";
import { catalogueStats } from "./catalogue";

type Probe = {
  path: string;
  ok: boolean;
  status?: number;
  detail: unknown;
};

async function probe<T>(
  label: string,
  fn: () => Promise<T>
): Promise<Probe> {
  try {
    const detail = await fn();
    return { path: label, ok: true, detail };
  } catch (error) {
    if (error instanceof ElMicrosoftError) {
      return { path: label, ok: false, status: error.status, detail: error.message };
    }
    return {
      path: label,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function diagnoseSharePointAndSearch(env: Env): Promise<unknown> {
  const ctx = await createMicrosoftContext(env);
  const { graph, config, policy } = ctx;
  const hostname = config.sharePointHostname;
  const probes: Probe[] = [];

  const siteGets = [
    `/sites/${hostname}?$select=id,displayName,name,webUrl,siteCollection`,
    `/sites/${hostname}:/?$select=id,displayName,name,webUrl`,
    `/sites/root?$select=id,displayName,name,webUrl`,
    `/sites?search=*&$select=id,displayName,name,webUrl&$top=50`,
    `/sites?search=${encodeURIComponent("elvex")}&$select=id,displayName,name,webUrl&$top=25`,
    `/sites/getAllSites?$select=id,displayName,name,webUrl&$top=50`,
  ];

  const sites: Array<{
    id: string;
    displayName?: string | null;
    name?: string | null;
    webUrl?: string | null;
  }> = [];
  const seen = new Set<string>();

  for (const path of siteGets) {
    const result = await probe(path, () => graph.get<unknown>(path));
    probes.push(result);
    if (!result.ok) continue;
    const payload = result.detail as {
      id?: string;
      displayName?: string;
      name?: string;
      webUrl?: string;
      value?: Array<{ id?: string; displayName?: string; name?: string; webUrl?: string }>;
    };
    const batch = payload.value ?? (payload.id
      ? [{ id: payload.id, displayName: payload.displayName, name: payload.name, webUrl: payload.webUrl }]
      : []);
    for (const site of batch) {
      if (site.id && !seen.has(site.id)) {
        seen.add(site.id);
        sites.push({
          id: site.id,
          displayName: site.displayName,
          name: site.name,
          webUrl: site.webUrl,
        });
      }
    }
  }

  const siteDetails = [];
  for (const site of sites.slice(0, 20)) {
    const drives = await probe(`${site.id}/drives`, () =>
      graph.get<{
        value?: Array<{ id?: string; name?: string; driveType?: string; webUrl?: string; quota?: unknown }>;
      }>(`/sites/${site.id}/drives?$select=id,name,driveType,webUrl,quota`)
    );
    const lists = await probe(`${site.id}/lists`, () =>
      graph.get<{ value?: Array<{ id?: string; displayName?: string; list?: { template?: string } }> }>(
        `/sites/${site.id}/lists?$select=id,displayName,list&$top=20`
      )
    );
    const permissions = await probe(`${site.id}/permissions`, () =>
      graph.get<unknown>(`/sites/${site.id}/permissions`)
    );
    const driveRows = drives.ok
      ? ((drives.detail as { value?: Array<{ id: string; name?: string; driveType?: string; webUrl?: string }> })
          .value ?? [])
      : [];
    const children: unknown[] = [];
    for (const drive of driveRows.slice(0, 5)) {
      const child = await probe(`drive ${drive.id} children`, () =>
        graph.get<{ value?: unknown[] }>(
          `/drives/${drive.id}/root/children?$top=15&$select=id,name,size,folder,file,webUrl`
        )
      );
      const search = await probe(`drive ${drive.id} search(q='document')`, () =>
        graph.get<unknown>(`/drives/${drive.id}/root/search(q='document')?$top=5`)
      );
      children.push({
        driveId: drive.id,
        name: drive.name,
        driveType: drive.driveType,
        webUrl: drive.webUrl,
        children: child,
        search,
      });
    }
    siteDetails.push({
      site,
      drives,
      lists,
      permissions,
      children,
    });
  }

  const graphSearch = await probe("POST /search/query driveItem document region=GBR", () =>
    graph.post<unknown>("/search/query", {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: "document" },
          from: 0,
          size: 10,
          region: "GBR",
        },
      ],
    })
  );
  probes.push(graphSearch);

  const graphSearchEur = await probe("POST /search/query driveItem ELVEX region=EUR", () =>
    graph.post<unknown>("/search/query", {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: "ELVEX" },
          from: 0,
          size: 10,
          region: "EUR",
        },
      ],
    })
  );
  probes.push(graphSearchEur);

  const groups = await probe("GET /groups", () =>
    graph.get<{
      value?: Array<{
        id: string;
        displayName?: string;
        mail?: string;
        groupTypes?: string[];
        resourceProvisioningOptions?: string[];
      }>;
    }>(
      "/groups?$select=id,displayName,mail,groupTypes,resourceProvisioningOptions&$top=50"
    )
  );
  probes.push(groups);
  const groupSites: unknown[] = [];
  if (groups.ok) {
    const rows =
      (groups.detail as { value?: Array<{ id: string; displayName?: string; mail?: string }> }).value ??
      [];
    for (const group of rows.slice(0, 25)) {
      const site = await probe(`group ${group.displayName} site`, () =>
        graph.get<{ id?: string; displayName?: string; webUrl?: string; name?: string }>(
          `/groups/${group.id}/sites/root?$select=id,displayName,name,webUrl`
        )
      );
      groupSites.push({ group, site });
    }
  }

  const groupLibraries: unknown[] = [];
  let teamSiteLibrariesWithFiles = 0;
  let teamSiteLibrariesEmpty = 0;
  let teamSiteLibrariesAccessDenied = 0;
  const sitesSelectedCandidates: Array<{
    siteName: string | null;
    siteUrl: string | null;
    siteId: string;
    requiredPermission: string;
    action: string;
  }> = [];

  for (const row of groupSites) {
    const wrapped = row as {
      group: { displayName?: string };
      site: Probe;
    };
    if (!wrapped.site.ok) continue;
    const site = wrapped.site.detail as { id?: string; displayName?: string; webUrl?: string };
    if (!site.id) continue;
    const drives = await probe(`group-site ${site.displayName} drives`, () =>
      graph.get<{ value?: Array<{ id: string; name?: string; driveType?: string; webUrl?: string }> }>(
        `/sites/${site.id}/drives?$select=id,name,driveType,webUrl`
      )
    );
    if (!drives.ok) {
      teamSiteLibrariesAccessDenied += 1;
      sitesSelectedCandidates.push({
        siteName: site.displayName ?? wrapped.group.displayName ?? null,
        siteUrl: site.webUrl ?? null,
        siteId: site.id,
        requiredPermission: "read",
        action:
          "Grant Sites.Selected Read on this site to the existing Entra app INFRA - Elvex MCP (f8ec6a91-f043-4f63-8800-64135af48c4e).",
      });
      groupLibraries.push({ site, drives });
      continue;
    }
    const driveRows =
      (drives.detail as { value?: Array<{ id: string; name?: string; driveType?: string; webUrl?: string }> }).value ??
      [];
    const libraries = [];
    for (const drive of driveRows.slice(0, 6)) {
      const child = await probe(`group-site drive ${drive.id} children`, () =>
        graph.get<{ value?: Array<{ id?: string; name?: string; folder?: unknown; file?: unknown }> }>(
          `/drives/${drive.id}/root/children?$top=15&$select=id,name,folder,file,size,webUrl`
        )
      );
      const files = child.ok
        ? ((child.detail as { value?: Array<{ file?: unknown; folder?: unknown; name?: string }> }).value ?? []).filter(
            (item) => item.file || !item.folder
          )
        : [];
      const folders = child.ok
        ? ((child.detail as { value?: Array<{ folder?: unknown }> }).value ?? []).filter((item) => item.folder)
        : [];
      if (!child.ok) {
        teamSiteLibrariesAccessDenied += 1;
        sitesSelectedCandidates.push({
          siteName: site.displayName ?? null,
          siteUrl: site.webUrl ?? null,
          siteId: site.id,
          requiredPermission: "read",
          action:
            "Grant Sites.Selected Read on this site to the existing Entra app INFRA - Elvex MCP (f8ec6a91-f043-4f63-8800-64135af48c4e).",
        });
      } else if (files.length === 0 && folders.length === 0) {
        teamSiteLibrariesEmpty += 1;
      } else {
        teamSiteLibrariesWithFiles += 1;
      }
      libraries.push({
        driveId: drive.id,
        name: drive.name,
        webUrl: drive.webUrl,
        childrenOk: child.ok,
        fileCountSample: files.length,
        folderCountSample: folders.length,
        sampleNames: (child.ok
          ? ((child.detail as { value?: Array<{ name?: string }> }).value ?? []).map((item) => item.name)
          : []),
        error: child.ok ? null : child.detail,
      });
    }
    groupLibraries.push({ site, driveCount: driveRows.length, libraries });
  }

  const grantProbeSite = sitesSelectedCandidates[0] ?? null;
  let sitesSelectedGrantProbe: Probe | null = null;
  if (grantProbeSite) {
    sitesSelectedGrantProbe = await probe("POST Sites.Selected self-grant", () =>
      graph.post<unknown>(`/sites/${grantProbeSite.siteId}/permissions`, {
        roles: ["read"],
        grantedToIdentities: [
          {
            application: {
              id: config.clientId,
              displayName: "INFRA - Elvex MCP",
            },
          },
        ],
      })
    );
  }

  const extraSitePaths = [
    "elvex",
    "ELVEX",
    "team",
    "Team",
    "documents",
    "Documents",
    "company",
    "shared",
    "intranet",
    "hub",
    "ops",
    "operations",
  ].map((name) => `/sites/${hostname}:/sites/${name}?$select=id,displayName,name,webUrl`);
  const extraSites: Probe[] = [];
  for (const path of extraSitePaths) {
    extraSites.push(await probe(path, () => graph.get<unknown>(path)));
  }

  const oneDrives = await listEligibleOneDrives(graph, policy);
  const sampleOneDrive = oneDrives.eligible[0];
  let oneDriveSearch: Probe | null = null;
  let oneDriveChildren: Probe | null = null;
  if (sampleOneDrive) {
    oneDriveChildren = await probe(`eligible onedrive children ${sampleOneDrive.id}`, () =>
      graph.get<unknown>(
        `/drives/${sampleOneDrive.id}/root/children?$top=10&$select=id,name,folder,file,webUrl`
      )
    );
    oneDriveSearch = await probe(`eligible onedrive search ${sampleOneDrive.id}`, () =>
      graph.get<unknown>(`/drives/${sampleOneDrive.id}/root/search(q='ELVEX')?$top=5`)
    );
  }

  const catalogue = env.EL_BUSINESS_DATA ? await catalogueStats(env.EL_BUSINESS_DATA).catch(() => null) : null;

  return {
    hostname,
    approvedMailboxes: config.approvedMailboxes,
    protectedUsers: policy.snapshot().protectedUsers.map((user) => ({
      id: user.id,
      mail: user.mail,
      displayName: user.displayName,
      driveId: user.driveId,
    })),
    discoveredSiteCount: sites.length,
    sites,
    siteDetails,
    graphSearch,
    graphSearchEur,
    groups: groups.ok
      ? (groups.detail as { value?: unknown[] }).value?.map((g) => g)
      : groups,
    groupSites,
    groupLibraries,
    sharePointEvidence: {
      communicationSitesFoundViaSearch: sites.length,
      teamSitesViaGroups: groupSites.filter((row) => (row as { site: Probe }).site.ok).length,
      teamSiteLibrariesWithFiles,
      teamSiteLibrariesEmpty,
      teamSiteLibrariesAccessDenied,
      sitesSelectedGrantRequired: sitesSelectedCandidates,
      sitesSelectedSelfGrantPossible: Boolean(sitesSelectedGrantProbe?.ok),
      sitesSelectedGrantProbe,
    },
    extraSites: extraSites.map((p) => ({ path: p.path, ok: p.ok, status: p.status, preview: summarize(p.detail) })),
    eligibleOneDriveCount: oneDrives.eligible.length,
    excludedOneDriveCount: oneDrives.excluded.length,
    sampleEligibleOwner: sampleOneDrive?.owner ?? null,
    oneDriveChildren,
    oneDriveSearch,
    catalogue,
    probes: probes.map((p) => ({ path: p.path, ok: p.ok, status: p.status, preview: summarize(p.detail) })),
  };
}

function summarize(detail: unknown): unknown {
  if (typeof detail === "string") return detail.slice(0, 400);
  try {
    return JSON.parse(JSON.stringify(detail, (_, value) => value, 2));
  } catch {
    return String(detail);
  }
}
