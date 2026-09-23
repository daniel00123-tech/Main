import {
  PLATFORM_EMAIL_FROM_ADDRESS,
  PLATFORM_EMAIL_FROM_NAME,
  formatPlatformFromHeader,
} from "@infra/shared";
import type { Env } from "../../env";

export function resolvePlatformEmailIdentity(env?: Pick<Env, "EMAIL_FROM_NAME" | "EMAIL_FROM_ADDRESS" | "EMAIL_FROM">) {
  const fromHeader = env?.EMAIL_FROM?.trim();
  const match = fromHeader?.match(/^(.*)<([^>]+)>$/);
  const name = env?.EMAIL_FROM_NAME?.trim() || match?.[1]?.trim() || PLATFORM_EMAIL_FROM_NAME;
  const address = (
    env?.EMAIL_FROM_ADDRESS?.trim() ||
    match?.[2]?.trim() ||
    PLATFORM_EMAIL_FROM_ADDRESS
  ).toLowerCase();
  return {
    name,
    address,
    formatted: formatPlatformFromHeader(name, address),
  };
}
