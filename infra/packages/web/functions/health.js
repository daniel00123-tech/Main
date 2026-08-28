const API_ORIGIN = "https://infra-api.daniel-dwyer123.workers.dev";

export async function onRequest() {
  return fetch(`${API_ORIGIN}/health`);
}
