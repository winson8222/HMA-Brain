// Search and Ask across every selected connector at once.
//
// 1. Each connector retrieves AS THE ASKER, in parallel: filtered inside its own index query, then
//    re-checked live against its platform. Only permitted evidence comes back.
// 2. Scores from different indices aren't comparable, so the per-source rankings are merged with RRF,
//    then reranked once (Cohere) against the question, if configured.
// 3. Ask builds one prompt from the merged evidence; every search and answer is written to the
//    tamper-evident audit log before anything is returned.
import type { AuditDoc } from "./audit/chain.js";
import { appendAudit } from "./audit/store.js";
import { NO_INFO } from "./askRules.js";
import { connectors } from "./connectors/index.js";
import type { Connector, Evidence, RetrieveOpts } from "./connectors/types.js";
import { resolveRerank, rrfFuse } from "./hybrid.js";
import { chat } from "./llm.js";
import { getPrompt } from "./prompts.js";
import { applyRerankOrder, rerank } from "./rerank.js";
import type { AskMode } from "./search.js";
import { withSpan, withTrace } from "./tracing.js";

// What a person gets back: content fields only. No labels, no counts, nothing about withheld items.
export type Result = Omit<Evidence, "text"> & { sourceLabel: string };
export type Answer = { answer: string; keywords: string; sources: (Result & { n: number })[]; unavailable: string[] };

// ---- page audit log (the admin panel on index.html) ----
// Withheld items show only their title and location, never their text.
export type PageLogDoc = { id: string; source: string; title: string; location: string; text?: string };
export type LogEntry = {
  at: string;
  kind: "search" | "ask";
  mode: AskMode;
  personId: string;
  sources: string[];
  query: string;
  keywords?: string;
  answer?: string;
  allowed: PageLogDoc[];
  droppedByRecheck: PageLogDoc[];
  denied: PageLogDoc[];
};
export const auditLog: LogEntry[] = [];

function logEntry(e: Omit<LogEntry, "at" | "allowed" | "droppedByRecheck" | "denied">, evidence: Evidence[], docs: AuditDoc[]) {
  const text = new Map(evidence.map((x) => [x.ref, x.text]));
  const pick = (decision: AuditDoc["decision"]) =>
    docs
      .filter((d) => d.decision === decision)
      .map((d) => ({ id: d.doc_id, source: d.source, title: d.title, location: d.path ?? "", ...(decision === "allowed" ? { text: text.get(d.doc_id) } : {}) }));
  auditLog.unshift({ at: new Date().toISOString(), ...e, allowed: pick("allowed"), droppedByRecheck: pick("dropped"), denied: pick("denied") });
  auditLog.length = Math.min(auditLog.length, 200);
}

// ---- retrieval ----

export class UnknownSourceError extends Error {}

// Which connectors to use: the requested ones (validated), or all of them.
export function pickConnectors(sources?: unknown): Connector[] {
  if (sources === undefined || sources === null) return connectors;
  if (!Array.isArray(sources) || !sources.length) throw new UnknownSourceError("sources must be a non-empty list");
  const picked = connectors.filter((c) => sources.includes(c.name));
  const unknown = sources.filter((s) => !connectors.some((c) => c.name === s));
  if (unknown.length) throw new UnknownSourceError(`Unknown source(s): ${unknown.join(", ")}. Available: ${connectors.map((c) => c.name).join(", ")}`);
  return picked;
}

async function retrieveAll(personId: string, q: string, picked: Connector[], opts: RetrieveOpts & { rerankQuery: string }) {
  const unavailable: string[] = [];
  const perSource = await Promise.all(
    picked.map((c) =>
      withSpan(`${c.name}.retrieve`, { source: c.name, query: q }, () => c.retrieve(personId, q, { ...opts, size: opts.size * 2 })).catch((e) => {
        // One broken source must not take down the others. It contributes nothing (fail closed).
        console.error(`${c.label} search failed: ${String(e?.message ?? e)}`);
        unavailable.push(c.label);
        return { allowed: [] as Evidence[], audit: [] as AuditDoc[] };
      }),
    ),
  );

  const byRef = new Map<string, Evidence>();
  for (const r of perSource) for (const e of r.allowed) byRef.set(e.ref, e);
  let merged = rrfFuse(perSource.map((r) => r.allowed.map((e) => e.ref))).map((f) => byRef.get(f.id)!);

  // Only already-permitted text is ever sent to the reranker.
  if (resolveRerank() && merged.length > 1) {
    merged = await withSpan("rerank", { candidates: merged.length, sources: picked.map((c) => c.name) }, async () => {
      try {
        const order = await rerank(opts.rerankQuery, merged.map((e) => ({ text: `${e.title}\n${e.text}` })));
        return applyRerankOrder(merged, order).map((r) => r.item);
      } catch (e) {
        console.warn("rerank failed, keeping the merged order:", String((e as any)?.message ?? e));
        return merged;
      }
    });
  }

  return { evidence: merged.slice(0, opts.size), audit: perSource.flatMap((r) => r.audit), unavailable };
}

const toResult = ({ text: _text, ...e }: Evidence): Result => ({ ...e, sourceLabel: connectors.find((c) => c.name === e.source)?.label ?? e.source });

// ---- Search ----

export async function search(personId: string, q: string, mode: AskMode, sources?: unknown) {
  const picked = pickConnectors(sources);
  const names = picked.map((c) => c.name);
  return withTrace("search", { userId: personId, input: { query: q }, metadata: { mode, sources: names } }, async () => {
    const { evidence, audit, unavailable } = await retrieveAll(personId, q, picked, { size: 10, purpose: "search", rerankQuery: q });
    await appendAudit({ actor: personId, kind: "search", via: "web", sources: names, query: q, docs: audit });
    logEntry({ kind: "search", mode, personId, sources: names, query: q }, evidence, audit);
    return { results: evidence.map(toResult), unavailable };
  });
}

// ---- Ask ----

// Questions are full of words like "what" and "the"; turn them into search keywords first.
async function toKeywords(question: string, picked: Connector[]): Promise<string> {
  try {
    const k = await chat(
      [
        {
          role: "system",
          content:
            `Rewrite the user's question as 3-8 search keywords for a keyword search over company content (${picked.map((c) => c.label).join(", ")}). ` +
            "Include likely synonyms. Output only the keywords separated by spaces.",
        },
        { role: "user", content: question },
      ],
      { maxTokens: 1500, timeoutMs: 10_000, attempts: 2 },
    );
    const kw = k.replace(/[\n"]/g, " ").trim();
    return kw && kw.split(/\s+/).length <= 20 ? kw : question; // a long reply is prose (e.g. a refusal), not keywords
  } catch {
    return question;
  }
}

export function buildContext(evidence: Evidence[]): string {
  return evidence
    .map((e, i) => {
      const c = connectors.find((x) => x.name === e.source);
      return `[${i + 1}] ${c?.label ?? e.source} · ${c ? c.describe(e) : e.title}\n${e.text}`;
    })
    .join("\n\n");
}

export async function ask(personId: string, question: string, mode: AskMode, sources?: unknown): Promise<Answer> {
  const picked = pickConnectors(sources);
  const names = picked.map((c) => c.name);
  return withTrace("ask", { userId: personId, input: { query: question }, metadata: { mode, sources: names } }, async () => {
    const keywords = await toKeywords(question, picked);
    // The keyword rewrite drives the lexical legs; the raw question drives the semantic legs and the rerank.
    const { evidence, audit, unavailable } = await retrieveAll(personId, keywords, picked, {
      size: 8,
      purpose: "ask",
      vectorQuery: question,
      rerankQuery: question,
    });

    let answer = NO_INFO;
    let failure: string | null = null;
    if (evidence.length) {
      const used = new Set(evidence.map((e) => e.source));
      const hints = picked.filter((c) => used.has(c.name) && c.answerHint).map((c) => `- ${c.label}: ${c.answerHint}`);
      const rules = (await getPrompt("ask-answer-rules")) + (hints.length ? `\n${hints.join("\n")}` : "");
      try {
        // Only evidence this person may see right now is ever put in the prompt.
        answer = await chat([
          { role: "system", content: rules },
          { role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nExcerpts:\n\n${buildContext(evidence)}\n\nQuestion: ${question}` },
        ]);
      } catch (e: any) {
        failure = String(e?.message ?? e);
      }
    }

    const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const citedRefs = new Set(evidence.filter((_, i) => cited.has(i + 1)).map((e) => e.ref));
    for (const d of audit) if (d.decision === "allowed" && citedRefs.has(d.doc_id)) d.cited = true;

    // No answer goes out without its audit record.
    const logged = failure ? `(no answer: ${failure})` : answer;
    await appendAudit({ actor: personId, kind: "ask", via: "web", sources: names, query: question, keywords, answer: logged, docs: audit });
    logEntry({ kind: "ask", mode, personId, sources: names, query: question, keywords, answer: logged }, evidence, audit);
    if (failure) throw new Error(failure);

    const sourcesOut = evidence.map((e, i) => ({ n: i + 1, ...toResult(e) })).filter((s) => cited.has(s.n));
    return { answer, keywords, sources: sourcesOut, unavailable };
  });
}
