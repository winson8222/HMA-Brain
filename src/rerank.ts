// Cohere Rerank (v2 API). Reranks the fused candidate list so the most relevant
// permitted docs come first. On failure the caller keeps the pre-rerank order.
import { resolveRerank } from "./hybrid.js";

export function rerankConfigured(): boolean {
  return resolveRerank() && !!process.env.COHERE_API_KEY;
}

// Pure: map Cohere's {index, relevance_score} results back onto the candidate list,
// drop out-of-range indices, sort best-first.
export function applyRerankOrder<T>(
  items: T[],
  results: { index: number; relevance_score: number }[],
): { item: T; score: number }[] {
  return results
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < items.length)
    .map((r) => ({ item: items[r.index], score: r.relevance_score }))
    .sort((a, b) => b.score - a.score);
}

async function post(body: object, key: string): Promise<Response> {
  const base = (process.env.COHERE_BASE_URL ?? "https://api.cohere.com").replace(/\/$/, "");
  return fetch(`${base}/v2/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

// Returns Cohere's results (sorted by relevance). Throws on failure.
export async function rerank(query: string, docs: { text: string }[]): Promise<{ index: number; relevance_score: number }[]> {
  const key = process.env.COHERE_API_KEY;
  if (!key) throw new Error("Cohere not configured: set COHERE_API_KEY in .env");
  const body = {
    model: process.env.COHERE_MODEL ?? "rerank-v3.5",
    query,
    documents: docs.map((d) => ({ text: d.text })),
    top_n: docs.length,
  };
  let res = await post(body, key);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await post(body, key);
  }
  if (!res.ok) throw new Error(`Cohere rerank error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.results ?? [];
}
