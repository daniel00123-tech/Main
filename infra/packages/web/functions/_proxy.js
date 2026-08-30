import { API_ORIGIN } from "./_lib/urls.js";

/** Forward a Pages request to the INFRA API worker, keeping first-party cookies. */
export async function proxyToInfraApi(context) {
  const url = new URL(context.request.url);
  const target = `${API_ORIGIN}${url.pathname}${url.search}`;
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", "") || "https");
  headers.set("X-Forwarded-Origin", url.origin);

  const init = {
    method: context.request.method,
    headers,
    redirect: "manual",
  };

  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    init.body = context.request.body;
  }

  return fetch(target, init);
}
