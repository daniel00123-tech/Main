import { proxyToInfraApi } from "../_proxy.js";

/** Proxy /oauth/* so ChatGPT OAuth stays on app.infrastack.app with the portal session. */
export async function onRequest(context) {
  return proxyToInfraApi(context);
}
