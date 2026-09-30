# Retrieval roadmap

Planned improvements to Search and Ask, after hybrid retrieval, rerank and multi-workspace landed.
Written 2026-10-01. See [devlog.md](devlog.md) for what's already built and [demo-data.md](demo-data.md) for the test data.

## 1. Time awareness (not supported today)

**Current behaviour.** Asked "what is happening tomorrow?" on Thursday 1 Oct, Ask replies *"I don't have information on that… an all-hands on Friday, but no event is specified for tomorrow."* Three causes:
1. The LLM is never told today's date. It sees each message's timestamp but has no "now" to compare against.
2. Retrieval has no date filter or recency boost. "tomorrow" only becomes a keyword (`tomorrow schedule events…`), so it matches messages that contain the word.
3. Relative dates inside messages aren't resolved. "all-hands on Friday" was posted on Friday 25 Sep, so it means a Friday relative to *that* date.

**Plan, cheapest first:**
- [ ] **Today's date in the prompts.** Add the current date and time zone to `ANSWER_RULES` (`src/askRules.ts`) and to the keyword prompt in `toKeywords` (`src/ask.ts`). About one line each, and the LLM can then work out "tomorrow is Friday 2 Oct".
- [ ] **Date-range filters.** Turn time phrases ("tomorrow", "last week", "in the last 3 days") into a date range, inside each source's query next to its permission filter: Slack `ts`, Drive `modified_at`, in both the BM25 and kNN legs. Add a mild recency boost. This becomes the `from`/`to` of the agent's `search` tool (section 2).
- [ ] **Resolve relative dates at ingest.** When indexing, work out the actual dates behind "Friday" or "tomorrow" from the message's post time and store them as `mentioned_dates`. "What's on 2 Oct?" can then match. Needs a mapping change and a backfill.

## 2. Multi-step retrieval across sources ("Agentic Ask")

**Problem.** Ask runs one retrieval over one source, then one answer. Real questions leave a trail, and the trail crosses platforms: a Slack message points to a Drive doc, which points back to a Slack channel. The agent has to follow pointers wherever they lead, while seeing only what the asker may see in **each** source.

### Example (from the demo data)

Alice asks: *"The payment DB is saturated again. What do I do, and what happened last time?"*

| Step | Tool call | Finds | Pointer it follows |
|---|---|---|---|
| 1 | `search("payment database saturated", sources=all)` | **Drive** · Incident response handbook: *"Payment database saturation: follow the Payment service runbook in this folder."* | → the runbook |
| 2 | `search("Payment service runbook", sources=[drive])` | **Drive** · Payment service runbook: failover steps (drain pay-db-1, promote the replica, restart the payment API pods), *"Escalation: #payments-incident"* | → the Slack channel |
| 3 | `search("failover root cause", sources=[slack], where="#payments-incident")` | **Slack** · #payments-incident: root cause was pool exhaustion after the migration flag; failover to pay-db-2/pay-db-3; PAY-240, PAY-241 | done |
| → | answer | The runbook steps, plus what happened last time, citing Drive [1][2] and Slack [3][4] | |

The same question as other people:

| Asker | Step 1 (handbook) | Step 2 (runbook) | Step 3 (#payments-incident) | Answer |
|---|---|---|---|---|
| Alice | ✅ | ✅ | ✅ | full picture |
| Bob | ✅ | ✅ (Runbooks folder is shared with him) | ✗ not a member | runbook steps only |
| Dave | ✗ | ✗ | ✗ | "I don't have information on that" |

For Bob, the pointer *"Escalation: #payments-incident"* is in a doc he may read, so the agent may try step 3. The server returns nothing, and the answer must not hint at what the channel holds.

A second trail in the demo data, for vendors: Dave asks *"What's our SLA with Acme, and did the outage breach it?"*
- **Drive** · Vendor SLA agreement.pdf gives 99.9% availability.
- **Slack** · #vendor-general says the SLA review is due Friday.
- Only for Carol: **Slack** · #vendor-contracts has the $40k credit.

### Design

```
question → LLM ──tool call──▶ search(query, sources?, where?, from?, to?) ─┐
                                    │  fan out, in parallel, AS THE ASKER   │
                                    ├─▶ Slack retriever  (filter · re-check)│
                                    ├─▶ Drive retriever  (filter · re-check)│
                                    └─▶ …future: Gmail, Confluence, Jira    │
              ◀── merged evidence (RRF across sources → rerank) ───────────┘
           …repeat until enough, max ~4 calls…  → answer citing every step
```

**One retriever interface per source.** Each connector implements the same contract, and the agent never needs to know how a source stores data:
```ts
type Source = "slack" | "drive"; // later: "gmail", "confluence", "jira", …

type Evidence = {
  source: Source;
  ref: string;          // stable id: slack:<team>:<channel>:<ts> · drive:<fileId>:<chunk>
  title: string;        // "#payments-incident" · "Payment service runbook"
  location: string;     // "Company A Demo" · "Company A / Engineering / Runbooks"
  author: string | null;
  time: string | null;  // Slack: ts · Drive: modified_at
  text: string;
  permalink: string;
};

interface Retriever {
  source: Source;
  // Must filter by the person's permissions inside the query AND re-check live, like today.
  search(personEmail: string, q: string, f: { where?: string; from?: string; to?: string; size: number }): Promise<Evidence[]>;
  // Fetch one item in full (a whole Slack thread, a whole Drive doc), with the same permission checks.
  open(personEmail: string, ref: string): Promise<Evidence[]>;
}
```
- Slack wraps today's `retrieve(personId, …)` in `src/search.ts`. Drive wraps `retrieve(email, …)` in `src/connectors/drive/query.ts` (drive-connector branch).
- **Identity:** both already key people by **email** (Slack `personId`, Drive `driveKeysFor(email)`), so one asker maps to both sources. Slack people without an email fall back to a workspace-scoped ID and get no Drive access, which is correct and fails closed.

**Tools the LLM gets:**
- `search(query, sources?, where?, from?, to?)`. `sources` defaults to all. `where` is a channel (`#payments-incident`) or a folder path (`Engineering/Runbooks`). The date range comes from section 1.
- `open(ref)` reads a full Drive doc or Slack thread when a chunk isn't enough, such as step 2 above.

**Merging across sources.** BM25 and vector scores aren't comparable between indices, so:
1. Merge each source's ranked list with RRF, the same `rrfFuse` used today.
2. Run Cohere rerank over the combined list. Rerank scores text against the question, so it works across sources.

**Cross-source links at ingest** (makes pointers cheap to follow):
- Slack messages with a `docs.google.com` link: store the file IDs as `linked_refs`.
- Drive text that mentions `#channel`: resolve it to the channel ID and store it too.
- The agent can then `open()` a linked item directly instead of searching for it. `open()` still re-checks permissions, so a link never grants access.

**Permissions (unchanged rules, now per source):**
- Every tool call runs **server-side as the asker**. The LLM never passes an identity, and can't widen access.
- Each retriever keeps its own filter-in-query and live re-check: Slack membership and channel privacy, and Drive's live `getMeta` sharing check, which fails closed.
- Evidence the asker can't see is dropped before the LLM sees it. Only the audit log records it.

**Audit.** Log every tool call, not just the final answer, as one entry per hop to the tamper-evident `brain-audit` log from drive-connector. Move Slack's in-memory `auditLog` onto it at the same time, which also fixes the `/api/log` issue below.

**Limits.**
- At most 3–4 tool calls, a total time budget, and a stop when a call returns nothing new.
- Each step costs about 2–8s with TokenHub, so simple questions keep the single-step path. A cheap first call can decide whether a trail is needed.

**Tracing.** One Langfuse span per tool call, tagged with `source`, so the waterfall shows the trail: Drive → Drive → Slack.

**Provider.** This needs tool/function calling. Check that TokenHub `hy4-preview` supports it, or use a prompt-based JSON loop.

### Build order
1. **Merge `drive-connector`.** Point `knnQuery` and every source query at its own index; `knnQuery` already names the Slack index.
2. **`Evidence` + `Retriever` interface.** Wrap the Slack and Drive retrievers. Ask becomes a **single-step federated search** (both sources, RRF, rerank). This is useful on its own, before any agent.
3. **Embeddings for Drive chunks** (`text_vector` on `brain-drive`), so both sources get hybrid search.
4. **Agent loop** with `search` + `open`, limits, a span per hop, and audit per hop.
5. **Cross-source `linked_refs`** at ingest.
6. **Golden dataset** with cross-source questions, like the two trails above, to measure each step.

## 3. Other improvements

| Idea | What it fixes | Effort |
|---|---|---|
| **Pull in thread and nearby messages** | A match is often a reply or "see above". Add the thread parent and replies (`thread_ts` is already indexed) and neighbouring messages before calling the LLM. | Small |
| **Faster permission re-check** | About 3s per query: `getChannel(…, true)` runs once per hit, one after another. Fetch each distinct channel once, in parallel. Just as strict, since every channel is still fetched fresh. | Small |
| **Cache question embeddings** | Repeated questions skip the OpenAI call. | Small |
| **Rerank on the original question** | In Ask, rerank scores against the extracted keywords. The full question suits Cohere better. | Small |
| **More candidates in keyword-only mode** | Keyword-only fetches just `size` candidates, so rerank barely helps. Fetch `hybridCandidates` there too. | Small |
| **Chunk long Slack content** | One Slack message is one doc. Long posts and file attachments need chunking; Drive already chunks by heading. | Medium |
| **Golden dataset + eval harness** | Measure each change (hit rate at k, answer correctness) across `RETRIEVAL_MODE`, `RERANK` and `MULTI_QUERY` instead of guessing. | Medium |

## Known issues to fix alongside

- **`/api/log` has no access control.** It returns every person's questions and the text of withheld private-channel messages (DM text is already hidden). Put it behind an admin check, like `requireAdmin` on `drive-connector`, or stop storing withheld text.
- **`drive-connector` isn't merged** into this branch yet. It's the first step of section 2.

## Suggested order

1. Today's date in the prompts, then date-range filters: small and very visible in a demo.
2. Thread and nearby-message context, and the faster re-check.
3. Section 2, in its build order: merge Drive, federated single-step Ask, Drive embeddings, then the agent loop.
4. Golden dataset with single-source and cross-source questions, to measure 1–3.
