import "dotenv/config";

// npm run judge [limit] — LLM-as-judge over recent Ask traces.
//
// Pulls ask traces from Langfuse (new-org v2 observations API), has the LLM score each
// answer's faithfulness against the numbered messages it was grounded in, and posts the
// score back to the trace so it shows up next to the waterfall in the Langfuse UI.
//
// Requires LANGFUSE_* and LLM_* env. Traces already carrying a "faithfulness" score are
// skipped, so the script is idempotent and resumable.
import { chat } from "./llm.js";

const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
const auth = () => {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
    throw new Error("Langfuse not configured: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env");
  return "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
};

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: auth() } });
  if (!res.ok) throw new Error(`Langfuse API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// v2 observations API is cursor-paginated and requires a bounded time range.
async function listObservations(params: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ ...params, limit: "1000", ...(cursor ? { cursor } : {}) });
    const page = await getJson(`/api/public/v2/observations?${q}`);
    out.push(...(page.data ?? []));
    cursor = page.meta?.cursor;
  } while (cursor);
  return out;
}

const parseIo = (row: any) => {
  const tryParse = (v: any) => {
    try {
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return v;
    }
  };
  return { ...row, input: tryParse(row.input), output: tryParse(row.output) };
};

// Recent trace rows named "ask" within the lookback window.
async function listAskTraces(lookbackHours: number, limit: number): Promise<any[]> {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackHours * 3600_000);
  const rows = await listObservations({
    fromStartTime: from.toISOString().slice(0, 19) + "Z",
    toStartTime: to.toISOString().slice(0, 19) + "Z",
    fields: "core,basic,io",
  });
  return rows
    .map(parseIo)
    .filter((r) => r.isRootObservation && r.name === "ask") // v4 model: the trace root is a SPAN named after the entry point
    .sort((a, b) => (a.startTime < b.startTime ? 1 : -1))
    .slice(0, limit);
}

async function alreadyScored(traceId: string): Promise<boolean> {
  const { data } = await getJson(`/api/public/v3/scores?traceId=${traceId}&limit=50`);
  return (data ?? []).some((s: any) => s.name === "faithfulness");
}

// The answer generation is the llm.chat whose input carries the numbered message context.
async function findAnswerGeneration(traceId: string): Promise<any | null> {
  const rows = (await listObservations({ traceId, fields: "core,basic,io" }))
    .map(parseIo)
    .filter((r) => r.type === "GENERATION" && r.name === "llm.chat");
  return rows.find((g) => JSON.stringify(g.input ?? "").includes("Messages:")) ?? null;
}

// input is the [system, user] messages array we sent; the user message holds the context.
function parseContextAndQuestion(input: any[]): { context: string; question: string } | null {
  const user = (input ?? []).map((m: any) => m?.content).find((c: any) => typeof c === "string" && c.includes("Messages:"));
  if (!user) return null;
  const m = user.match(/Messages:\n\n([\s\S]*?)\n\nQuestion: (.*)$/);
  return m ? { context: m[1], question: m[2] } : null;
}

const JUDGE_RULES = `You are a strict evaluator of retrieval-grounded answers.
Given QUESTION, numbered CONTEXT messages, and an ANSWER, score how faithful the ANSWER is to the CONTEXT:
- 5: every claim is directly supported by the cited messages; no unsupported content.
- 3: mostly supported, with minor unsupported additions or omissions.
- 1: the answer states things the context does not support, or cites the wrong messages.
- Judge ONLY faithfulness to the context, not whether the answer is helpful.
Reply with JSON only: {"score": <1-5>, "reason": "<one sentence>"}`;

async function judgeOne(gen: any): Promise<{ score: number; reason: string } | null> {
  if (!gen?.output) return null; // e.g. the ask failed before answering
  const parsed = parseContextAndQuestion(gen.input);
  if (!parsed) return null;

  const out = await chat(
    [
      { role: "system", content: JUDGE_RULES },
      {
        role: "user",
        content: `QUESTION: ${parsed.question}\n\nCONTEXT:\n${parsed.context}\n\nANSWER: ${gen.output}`,
      },
    ],
    { maxTokens: 500 },
  );
  const json = out.match(/\{[\s\S]*\}/);
  if (!json) return null;
  const verdict = JSON.parse(json[0]);
  return { score: Number(verdict.score), reason: String(verdict.reason ?? "") };
}

async function postScore(traceId: string, score: number, reason: string, attempt = 0): Promise<void> {
  const res = await fetch(`${base}/api/public/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth() },
    body: JSON.stringify({ traceId, name: "faithfulness", value: score, comment: reason, dataType: "NUMERIC" }),
  });
  // Langfuse free tier rate-limits score writes — wait out the told retry window (up to 3 tries).
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 25);
    const told = Number((await res.json().catch(() => ({})))?.details?.retryAfterSeconds ?? retryAfter);
    console.log(`  rate limited, waiting ${told}s…`);
    await new Promise((r) => setTimeout(r, (told + 1) * 1000));
    return postScore(traceId, score, reason, attempt + 1);
  }
  if (!res.ok) throw new Error(`posting score failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const limit = Number(process.argv[2] ?? 10);
const lookbackHours = Number(process.argv[3] ?? 24);
const traces = await listAskTraces(lookbackHours, limit * 3);
const pending: any[] = [];
for (const t of traces) {
  if (pending.length >= limit) break;
  if (!(await alreadyScored(t.traceId))) pending.push(t);
}
if (!pending.length) {
  console.log("No new ask traces to judge.");
  process.exit(0);
}

const rows: { trace: string; question: string; score: string; reason: string }[] = [];
for (const t of pending) {
  const question = String(t.input?.query ?? "?");
  try {
    const gen = await findAnswerGeneration(t.traceId);
    const verdict = await judgeOne(gen);
    if (!verdict) {
      rows.push({ trace: t.traceId.slice(0, 8), question, score: "skip", reason: "no answer on trace" });
      continue;
    }
    await postScore(t.traceId, verdict.score, verdict.reason);
    rows.push({ trace: t.traceId.slice(0, 8), question, score: String(verdict.score), reason: verdict.reason });
  } catch (e) {
    rows.push({ trace: t.traceId.slice(0, 8), question, score: "error", reason: String((e as any)?.message ?? e).slice(0, 120) });
  }
}
console.table(rows);
