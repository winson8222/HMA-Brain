# Devlog

Chronological record of what was built on this repo, why, and what's pending.
Most recent session first.

---

## Session 2 — 2026-09-29 — Hybrid retrieval + rerank + Langfuse tracing + multi-query

**Branch:** `enhanced-retrieval` (off `main`). **Nothing committed yet** — all
changes are working-tree only (see pending list at the bottom).

Base app before this session: BM25-only RAG. `retrieve()` in `src/search.ts`
ran a permission-filtered `match` query over one shared ES index and fed the
top hits to the LLM. Permission model: docs carry `acl_container` labels, the
ACL filter goes **inside** the query clause (never `post_filter`), `retrieve()`
is the sole retrieval entry, plus a live re-check and a shadow audit query.

### 1. Hybrid search (BM25 + kNN, client-side RRF)

- **`src/embeddings.ts`** — OpenAI-compatible `/embeddings` client.
  `embeddingConfigured()` reads `EMBEDDING_MODEL` + `EMBEDDING_DIMS` at call
  time (not import time — tests stub env). `embedTexts` batches at 64, retries
  429/5xx, retries once without the `dimensions` param on 400. `withVectors`
  enriches docs at ingest (sync + live events); embed failure ⇒ doc indexed
  without a vector, lexical still works, next backfill fills it.
- **`src/hybrid.ts`** — pure helpers: `resolveRetrievalMode()`
  (`RETRIEVAL_MODE` wins; default hybrid iff embeddings configured),
  `knnQuery()` (ACL filter **inside** the knn clause — security regression
  test guards this), `rrfFuse()` (client-side because ES's `rrf` retriever
  needs an Enterprise license; the docker-compose ES is Basic, but kNN itself
  is free on Basic). RRF: score = Σ 1/(60+rank), ties break by first
  appearance for determinism.
- **`src/es.ts`** — conditional `text_vector` dense_vector mapping (cosine,
  `EMBEDDING_DIMS`) inside `properties`; `ensureIndex()` warns "run
  `npm run backfill`" if the index exists but lacks the field.
  **Gotcha hit:** the conditional spread was first placed as a *sibling* of
  `properties` → `mapper_parsing_exception` on real ES. Fix: inside the block.
- **`src/search.ts`** — hybrid branch: BM25 (`permissionedQuery`, 50
  candidates) ∥ kNN (50) in parallel → dedupe → RRF → top 20 → existing live
  re-check → optional rerank → slice to size (8 Ask / 10 Search). Shadow audit
  query unchanged (lexical over the raw query). No chunking: one Slack message
  = one doc.
- Funnel numbers (asked & answered): both legs k=50 → fused 100 → dedupe →
  **20** (`FUSE_TOP`) → rerank sees ≤20 → LLM gets **8**. Known gap: lexical
  mode fetches only `size` candidates, so rerank barely helps there — worth
  deepening before fair comparisons.

### 2. Cohere rerank

- **`src/rerank.ts`** — POST `api.cohere.com/v2/rerank`, model
  `rerank-v3.5` (`COHERE_BASE_URL`/`COHERE_MODEL` overridable), one 429
  retry. `resolveRerank()`: `RERANK=on|off` wins, default = has
  `COHERE_API_KEY`. On rerank error: fall back to the fused order (never
  fail the query).
- **Ordering invariant:** rerank runs **after** the permission re-check, so
  only already-permitted text is sent to Cohere (third party).

### 3. Langfuse v4 tracing (per-query waterfall)

- **`src/tracing.ts`** — lazy singleton, **no-op unless `LANGFUSE_*` set**
  (tests never touch network). v4 is OTel-based:
  `@langfuse/tracing` + `LangfuseSpanProcessor` + `startActiveObservation`,
  generations via `startObservation(..., {asType: "generation"})`.
  `withTrace` (search/ask roots), `withSpan` (named steps), `startGeneration`
  in `src/llm.ts` (model, I/O, token usage).
- Waterfall per ask: `ask → multiquery → hybrid.fetch (embed.query, fuse) →
  recheck → rerank → llm.chat ×2`. ~1 min export delay in the UI; silent on
  failure by design.
- **New-org API gotchas** (org created ≥ 2026-09-16 blocks legacy endpoints):
  reads via `GET /api/public/v2/observations` (needs `fromStartTime`/
  `toStartTime`, `fields=core,basic,io`, cursor pagination; trace roots are
  **SPAN rows** — filter `isRootObservation && name === "ask"`, there is no
  `type: "trace"`), scores via `GET /api/public/v3/scores?traceId=`, prompt
  POST needs `isActive: true`, score POST needs `dataType: "NUMERIC"`
  (uppercase). User's project is **US region** (`us.cloud.langfuse.com`).

### 4. Prompt management + LLM-as-judge (dev-side only)

- **`src/askRules.ts`** — `ANSWER_RULES` extracted (avoids import cycle);
  **`src/prompts.ts`** — `getPrompt("ask-answer-rules")` with 5-min cache,
  v2 API, falls back to the local constant. **`npm run prompts:seed`**
  (`src/pushPrompt.ts`) publishes the prompt with the `production` label.
- **`src/judge.ts`** (`npm run judge [limit] [lookbackHours]`) — pulls recent
  ask traces, finds the answer generation, has the LLM score **faithfulness**
  (answer vs cited context; rubric 5 = fully supported / 3 = minor gaps /
  1 = unsupported or wrong citations), posts the score back to the trace.
  Skips already-scored traces (idempotent). 429s honor the server-told
  retry window (up to 3 tries). First run: all traces scored 5/5.
- **Correctness scoring (needs reference answers) is explicitly parked**
  until the golden dataset exists. Judge is dev-side only — Langfuse keys
  never reach browsers.

### 5. Multi-query retrieval (semantic side) — newest

- **`src/multiQuery.ts`** — one LLM call rephrases the question into N
  statement-like paraphrases; `parseParaphrases` dedupes against the
  original **normalizing trailing `?`/`.`/`!`** (first version missed
  `"Why did payments fail?"` vs `"why did payments fail"`).
- **`src/hybrid.ts`** — `resolveMultiQuery()`: `off`/unset/0 → 0, `on` → 2,
  integer 1–5 otherwise, anything else → 0.
- **`src/search.ts`** — hybrid branch: paraphrase → embed all N+1 variants in
  one batch → N+1 kNN lists (alongside BM25) → all lists into `rrfFuse`. Any
  failure falls back to the plain single-vector path.
- Flag: `MULTI_QUERY=off|on|1..5` in `.env`. **Verified live**: `MULTI_QUERY=2`,
  ask waterfall shows the `multiquery` span (~1.6s — the main latency cost;
  extra kNN legs run in parallel, nearly free). 46/46 tests pass.

### Verification state

- `npm run typecheck` clean; **46/46 vitest** (new: rrf/knn/resolvers,
  rerank, tracing no-op, parseParaphrases).
- End-to-end on the real workspace: backfill embedded all docs (1536-dim),
  `npm run verify` PASS on all 8 channels; Alice (private-channel member)
  gets the root-cause message first on a semantic paraphrase; Dave/jithin
  see only public channels; audit intact.
- Langfuse waterfall confirmed per ask; judge ran clean and idempotently.

### Keys used (all in `.env`, gitignored — `.env.example` documents them)

`SLACK_BOT_TOKEN` · `LLM_*` (OpenAI-compatible chat) · `EMBEDDING_*`
(text-embedding-3-small, 1536 dims) · `COHERE_API_KEY` ·
`LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL` (US cloud).
Each enhancement degrades gracefully when its key is missing.

### Pending

1. **Commit the branch** — everything above is uncommitted.
2. **Golden dataset + eval harness** — deferred until teammate responds;
   flags (`RETRIEVAL_MODE`, `RERANK`, `MULTI_QUERY`) are designed for A/B
   comparison once it exists.
3. **Correctness scoring** — parked with the evals (needs reference keyFacts).
4. Deepen candidate pool in lexical mode so rerank is comparable across modes.

---

## Session 1 — 2026-09-29 — Setup (before this devlog existed)

- Cloned repo, installed Docker (colima)/Node deps, stood up ES + the app.
- Read the RAG pipeline; created branch `enhanced-retrieval`.
- Seeded the demo Slack workspace and backfilled for permission demos.
