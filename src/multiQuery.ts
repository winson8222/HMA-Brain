// Multi-query retrieval: rephrase the question N ways so the semantic leg gets
// several independent kNN lists (fused with everything else by rrfFuse).
// The LLM call is the caller's responsibility to guard on llmConfigured(); any
// failure here just yields fewer/no paraphrases and the caller falls back to
// the single-vector path.
import { chat } from "./llm.js";

// Pure: split the model's reply into clean paraphrase lines (max n, deduped,
// never equal to the original question). Unit-testable without network.
export function parseParaphrases(reply: string, n: number, original: string): string[] {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/[?!.]+$/, "");
  const seen = new Set([normalize(original)]);
  const out: string[] = [];
  for (const line of reply.split("\n")) {
    const p = line.replace(/^[-*\d.)\s]+/, "").trim();
    if (!p || seen.has(normalize(p))) continue;
    seen.add(normalize(p));
    out.push(p);
    if (out.length === n) break;
  }
  return out;
}

export async function paraphrase(question: string, n: number): Promise<string[]> {
  const reply = await chat(
    [
      {
        role: "system",
        content:
          `Rewrite the user's question as ${n} alternative phrasings that would retrieve the same information from a document search. Make them statement-like and concrete, not question-like. Output one phrasing per line, no numbering or bullets.`,
      },
      { role: "user", content: question },
    ],
    { maxTokens: 1500 },
  );
  return parseParaphrases(reply, n, question);
}
