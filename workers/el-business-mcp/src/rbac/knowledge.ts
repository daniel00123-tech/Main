import type { ElvexActor } from "./actor";
import { can } from "./authorize";
import {
  CLASSIFICATION_READ_CAPABILITY,
  effectiveClassificationForAccess,
  resolveClassification,
  type DataClassification,
} from "./classify";
import { listClassifications, listDirectoryClassifications } from "./store";

export type ClassifiableItem = {
  id?: string | null;
  driveId?: string | null;
  name?: string | null;
  path?: string | null;
  webUrl?: string | null;
};

export async function filterKnowledgeItems<T extends ClassifiableItem>(
  db: D1Database | undefined,
  actor: ElvexActor,
  items: T[]
): Promise<{ visible: T[]; hidden: number; engineerOnly: boolean }> {
  const directoryRules = db ? await listDirectoryClassifications(db) : [];
  const explicitRows = db ? await listClassifications(db) : [];
  const explicitByKey = new Map(explicitRows.filter((row) => row.source === "explicit").map((row) => [row.itemKey, row]));
  const visible: T[] = [];
  let hidden = 0;

  for (const item of items) {
    const itemKey = `${item.driveId ?? ""}:${item.id ?? item.path ?? item.webUrl ?? item.name ?? ""}`;
    const explicit = explicitByKey.get(itemKey) ?? null;
    const directory = matchDirectoryRule(directoryRules, item);
    const resolution = resolveClassification({
      explicit: explicit?.classification,
      directory: directory?.classification,
      name: item.name,
      path: item.path,
      webUrl: item.webUrl,
    });
    const effective = effectiveClassificationForAccess(resolution);
    const capability = CLASSIFICATION_READ_CAPABILITY[effective];
    const decision = can(actor, capability, {
      classification: effective,
      path: item.path ?? item.name,
      itemId: item.id,
    });
    if (decision.allowed) {
      visible.push(item);
    } else {
      hidden += 1;
    }
  }

  return {
    visible,
    hidden,
    engineerOnly: actor.role === "engineer",
  };
}

export function allowedClassificationsForActor(actor: ElvexActor): DataClassification[] {
  return (Object.keys(CLASSIFICATION_READ_CAPABILITY) as DataClassification[]).filter((classification) =>
    can(actor, CLASSIFICATION_READ_CAPABILITY[classification], { classification }).allowed
  );
}

function matchDirectoryRule(
  rules: Array<{ pathPattern: string | null; classification: DataClassification }>,
  item: ClassifiableItem
): { classification: DataClassification } | null {
  const hay = `${item.path ?? ""}\n${item.webUrl ?? ""}\n${item.name ?? ""}`.toLowerCase();
  for (const rule of rules) {
    const pattern = rule.pathPattern?.trim().toLowerCase();
    if (pattern && hay.includes(pattern)) {
      return { classification: rule.classification };
    }
  }
  return null;
}
