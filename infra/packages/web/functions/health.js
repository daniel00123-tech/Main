import { API_ORIGIN } from "./_lib/urls.js";

export async function onRequest() {
  return fetch(`${API_ORIGIN}/health`);
}
