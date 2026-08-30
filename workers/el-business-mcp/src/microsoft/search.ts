import type { Env } from "../env";
import { createMicrosoftContext } from "./context";
import {
  catalogueNeedsRefresh,
  searchCatalogue,
  syncEligibleCatalogue,
} from "./catalogue";
import {
  discoverSharePointSite,
  graphSearchDriveItems,
  listEligibleOneDrives,
  listSiteDrives,
  type FileHit,
} from "./files";

export type FileSearchInput = {
  query?: string;
  filename?: string;
  source?: "sharepoint" | "onedrive" | "all";
  top?: number;
};

export async function searchElvexFiles(
  env: Env,
  input: FileSearchInput
): Promise<{
  results: FileHit[];
  sharePoint: { id: string; displayName?: string | null; webUrl?: string | null } | null;
  sharePointDriveCount: number;
  eligibleOneDriveCount: number;
  excludedProtectedCount: number;
  catalogue: { indexed: number; refreshed: boolean; used: boolean };
  graphSearchHits: number;
}> {
  const ctx = await createMicrosoftContext(env);
  const query = (input.filename || input.query || "").trim();
  let refreshed = false;
  let indexed = 0;

  if (env.EL_BUSINESS_DATA) {
    const stale = await catalogueNeedsRefresh(env.EL_BUSINESS_DATA);
    if (stale) {
      const sync = await syncEligibleCatalogue(env.EL_BUSINESS_DATA, ctx.graph, ctx.config, ctx.policy);
      indexed = sync.indexed;
      refreshed = true;
    }
  }

  let results: FileHit[] = [];
  if (env.EL_BUSINESS_DATA) {
    results = await searchCatalogue(env.EL_BUSINESS_DATA, ctx.policy, input);
  }

  let graphSearchHits = 0;
  const wantsKeyword = Boolean((input.query || "").trim());
  if (query && (wantsKeyword || results.length < (input.top ?? 8))) {
    const graph = await graphSearchDriveItems(ctx.graph, query, ctx.policy);
    graphSearchHits = graph.hits.length;
    const seen = new Set(results.map((hit) => `${hit.driveId}:${hit.id}`));
    for (const hit of graph.hits) {
      const key = `${hit.driveId}:${hit.id}`;
      if (seen.has(key)) continue;
      if (ctx.policy.isProtectedDrive(hit.driveId) || ctx.policy.isProtectedUser(hit.owner)) continue;
      if (ctx.policy.isProtectedLocation(hit.webUrl, hit.path)) continue;
      if (input.source && input.source !== "all" && hit.sourceType !== input.source) continue;
      results.push(hit);
      seen.add(key);
    }
  }

  const site = input.source === "onedrive" ? null : await discoverSharePointSite(ctx.graph, ctx.config);
  const sharePointDrives = site ? await listSiteDrives(ctx.graph, site.id) : [];
  const oneDrives =
    input.source === "sharepoint"
      ? { eligible: [], excluded: [] }
      : await listEligibleOneDrives(ctx.graph, ctx.policy);

  return {
    results: results.slice(0, input.top ?? 20),
    sharePoint: site ? { id: site.id, displayName: site.displayName, webUrl: site.webUrl } : null,
    sharePointDriveCount: sharePointDrives.length,
    eligibleOneDriveCount: oneDrives.eligible.length,
    excludedProtectedCount: oneDrives.excluded.length,
    catalogue: { indexed, refreshed, used: Boolean(env.EL_BUSINESS_DATA) },
    graphSearchHits,
  };
}
