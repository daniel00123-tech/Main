import type { XeroFetchConfig } from "./fetch-json";
import { xeroGetJson } from "./fetch-json";

export const XERO_API_PAGE_SIZE = 100;

export type PaginationMeta = {
  returned: number;
  truncated: boolean;
  pagesFetched: number;
  message?: string;
};

export function buildPaginationMeta(
  returned: number,
  truncated: boolean,
  pagesFetched: number,
  message?: string,
): PaginationMeta {
  return {
    returned,
    truncated,
    pagesFetched,
    message: truncated
      ? message ??
        `Results may be incomplete — fetched ${returned} records before reaching the safety limit. Narrow filters or contact support if totals look low.`
      : undefined,
  };
}

export async function fetchAllPagedWithConfig<T>(
  config: XeroFetchConfig,
  path: string,
  collectionKey: string,
  where: string | undefined,
  maxRecords: number,
): Promise<{ rows: T[]; meta: PaginationMeta }> {
  const rows: T[] = [];
  let page = 1;
  while (rows.length < maxRecords) {
    const body = await xeroGetJson<Record<string, T[]>>(config, path, { where, page });
    const batch = body[collectionKey] ?? [];
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < XERO_API_PAGE_SIZE) break;
    page += 1;
  }
  const truncated = rows.length >= maxRecords;
  return {
    rows: rows.slice(0, maxRecords),
    meta: buildPaginationMeta(
      Math.min(rows.length, maxRecords),
      truncated,
      page,
      truncated ? `Pagination stopped at ${maxRecords} records (safety limit).` : undefined,
    ),
  };
}

/** In-memory pagination helper for unit tests. */
export function paginateInMemory<T>(
  allRows: T[],
  pageSize: number,
  maxRecords: number,
): { rows: T[]; meta: PaginationMeta } {
  const rows: T[] = [];
  let page = 0;
  for (let offset = 0; offset < allRows.length && rows.length < maxRecords; offset += pageSize) {
    page += 1;
    rows.push(...allRows.slice(offset, offset + pageSize));
  }
  const truncated = allRows.length > maxRecords;
  return {
    rows: rows.slice(0, maxRecords),
    meta: buildPaginationMeta(Math.min(rows.length, maxRecords), truncated, page),
  };
}
