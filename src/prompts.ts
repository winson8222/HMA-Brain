// Prompt management: prompts are versioned in Langfuse (Prompts → ask-answer-rules),
// fetched here with a short cache, and fall back to the in-code default when Langfuse
// is unset, the prompt doesn't exist, or Langfuse errors. Changing the prompt in the
// Langfuse UI takes effect within PROMPT_CACHE_TTL_MS — no deploy needed.
import { ANSWER_RULES } from "./askRules.js";

const PROMPT_CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { prompt: string; fetchedAt: number }>();

// Basic auth for the Langfuse public API (server-side only).
function langfuseAuth(): string | null {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return null;
  return "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
}

function langfuseBase(): string {
  return (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
}

let warned = false;
const warnOnce = (message: string) => {
  if (!warned) {
    console.warn(message);
    warned = true;
  }
};

async function fetchPrompt(name: string): Promise<string | null> {
  const auth = langfuseAuth();
  if (!auth) return null;
  try {
    const res = await fetch(`${langfuseBase()}/api/public/v2/prompts/${encodeURIComponent(name)}`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) {
      if (res.status !== 404) warnOnce(`Langfuse prompt ${name}: HTTP ${res.status} — using built-in default`);
      return null;
    }
    const data: any = await res.json();
    return typeof data.prompt === "string" ? data.prompt : null;
  } catch (e) {
    warnOnce(`Langfuse prompt fetch failed (${String((e as any)?.message ?? e)}) — using built-in default`);
    return null;
  }
}

export async function getPrompt(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.fetchedAt < PROMPT_CACHE_TTL_MS) return hit.prompt;
  const prompt = (await fetchPrompt(name)) ?? ANSWER_RULES;
  cache.set(name, { prompt, fetchedAt: Date.now() });
  return prompt;
}

// The Ask mode's system rules. Edit the "ask-answer-rules" prompt in the Langfuse UI
// to change it without a deploy; this default is also the fallback when Langfuse is off.
export { ANSWER_RULES };
