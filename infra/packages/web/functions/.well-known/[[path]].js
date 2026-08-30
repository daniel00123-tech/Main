import { proxyToInfraApi } from "../_proxy.js";

/** Proxy OAuth discovery so ChatGPT can find INFRA as the authorization server. */
export async function onRequest(context) {
  return proxyToInfraApi(context);
}
