import { API_ORIGIN } from "../_lib/urls.js";

/** Proxy /api/* to the INFRA API worker so session cookies stay first-party on Pages. */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = `${API_ORIGIN}${url.pathname}${url.search}`;
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
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
