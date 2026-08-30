import type { Env } from "../env";
import { unboundActor, type ElvexActor } from "./actor";
import { resolveActor } from "./identity";

type RbacContext = {
  env: Env;
  request: Request | null;
  actor: ElvexActor;
};

let current: RbacContext | null = null;

export async function runWithRbacContext<T>(
  env: Env,
  request: Request | null,
  fn: () => Promise<T> | T,
  actorOverride?: ElvexActor
): Promise<T> {
  const previous = current;
  const actor = actorOverride ?? (await resolveActor(env, request));
  current = { env, request, actor };
  try {
    return await fn();
  } finally {
    current = previous;
  }
}

export function getRbacContext(): RbacContext | null {
  return current;
}

export function getRequestActor(): ElvexActor {
  return current?.actor ?? unboundActor();
}

export function setRequestActor(actor: ElvexActor): void {
  if (current) current.actor = actor;
  else current = { env: {} as Env, request: null, actor };
}

export function clearRbacContext(): void {
  current = null;
}
