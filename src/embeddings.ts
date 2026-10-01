// Embeddings via any OpenAI-compatible /embeddings endpoint, configured in .env.
// Falls back to the chat LLM's provider (LLM_BASE_URL/LLM_API_KEY) when EMBEDDING_* is unset.
import { config } from "./config.js";
import type { BrainDoc } from "./slackDocs.js";

const embeddingModel = () => process.env.EMBEDDING_MODEL;
const embeddingBaseUrl = () =>
  (process.env.EMBEDDING_BASE_URL ?? process.env.LLM_BASE_URL)?.replace(/\/$/, "");
const embeddingApiKey = () => process.env.EMBEDDING_API_KEY ?? process.env.LLM_API_KEY;

// Hybrid needs a model AND the dims (dims define the index mapping, set in .env).
// Read at call time (like llmConfigured) so tests can stub env freely.
export function embeddingConfigured(): boolean {
  return !!(embeddingModel() && Number(process.env.EMBEDDING_DIMS) > 0);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const base = embeddingBaseUrl();
  if (!base || !embeddingModel()) throw new Error("Embedding not configured: set EMBEDDING_MODEL (and EMBEDDING_DIMS) in .env");

  const dims = process.env.EMBEDDING_DIMS ? Number(process.env.EMBEDDING_DIMS) : undefined;
  const body = () => ({
    model: embeddingModel(),
    input: texts,
    // Only send `dimensions` when explicitly configured; some providers reject it.
    ...(dims ? { dimensions: dims } : {}),
  });

  let res = await request(base, body());
  // Some providers 400 on the `dimensions` param — retry once without it.
  if (res.status === 400 && dims) {
    const text = await res.text();
    if (/dimension/i.test(text)) {
      console.warn("EMBEDDING: provider rejected `dimensions`, retrying without it");
      res = await request(base, { model: embeddingModel(), input: texts });
    } else {
      throw new Error(`Embedding error 400: ${text.slice(0, 300)}`);
    }
  }
  if (!res.ok) throw new Error(`Embedding error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data: any = await res.json();
  const vectors: number[][] = (data.data ?? []).map((d: any) => d.embedding);
  if (vectors.length !== texts.length) throw new Error(`Embedding returned ${vectors.length} vectors for ${texts.length} inputs`);
  if (dims && vectors[0]?.length !== dims)
    throw new Error(`Embedding model returned ${vectors[0]?.length} dims but EMBEDDING_DIMS=${dims} — fix EMBEDDING_DIMS in .env, then npm run backfill`);
  return vectors;
}

async function request(base: string, body: object, attempt = 0): Promise<Response> {
  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(embeddingApiKey() ? { Authorization: `Bearer ${embeddingApiKey()}` } : {}),
    },
    body: JSON.stringify(body),
  });
  // Rate limits and provider hiccups: back off and retry (1s, 3s).
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return request(base, body, attempt + 1);
  }
  return res;
}

// Embed a list of texts, split into batches. Throws on failure (query-time callers fall back to lexical).
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += config.embeddingBatch) {
    out.push(...(await embedBatch(texts.slice(i, i + config.embeddingBatch))));
  }
  return out;
}

export async function embedQuery(q: string): Promise<number[]> {
  return (await embedTexts([q]))[0];
}

// Ingest-time enrichment: attach `text_vector` to docs. No-op when embeddings aren't configured.
// A batch that fails to embed keeps its docs vector-less — lexical search still works,
// and the next `npm run backfill` fills the vectors in.
export async function withVectors<T extends BrainDoc>(docs: T[]): Promise<T[]> {
  if (!embeddingConfigured() || !docs.length) return docs;
  for (let i = 0; i < docs.length; i += config.embeddingBatch) {
    const slice = docs.slice(i, i + config.embeddingBatch);
    try {
      const vectors = await embedTexts(slice.map((d) => d.text));
      slice.forEach((d, j) => ((d as any).text_vector = vectors[j]));
    } catch (e) {
      console.warn(`embed failed for ${slice.length} docs (indexed without vectors):`, String((e as any)?.message ?? e));
    }
  }
  return docs;
}
