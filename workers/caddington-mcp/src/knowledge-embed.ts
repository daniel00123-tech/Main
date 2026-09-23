import { EMBEDDING_MODEL } from "./constants";
import type { Env } from "./db";

export async function embedText(env: Env, text: string): Promise<number[]> {
  const response = await env.AI.run(EMBEDDING_MODEL, { text });
  const data = (response as { data?: number[][] }).data;
  if (!data?.[0]) {
    throw new Error("Embedding model returned no vectors.");
  }
  return data[0];
}
