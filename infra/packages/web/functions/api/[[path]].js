const API_ORIGIN = "https://infra-api.daniel-dwyer123.workers.dev";

/** Proxy /api/* to the INFRA API worker so session cookies stay first-party on Pages. */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = `${API_ORIGIN}${url.pathname}${url.search}`;
  const headers = new Headers(context.request.headers);
  headers.delete("host");

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
