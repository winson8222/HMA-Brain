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
                                    ├─▶ Slack connector  (filter · re-check)│
                                    ├─▶ Drive connector  (filter · re-check)│
                                    └─▶ any registered connector (same API) │
              ◀── merged evidence (RRF across sources → rerank) ───────────┘
           …repeat until enough, max ~4 calls…  → answer citing every step
```

**Any platform plugs in the same way.** The agent, merging, rerank, audit and UI never know which platforms exist. Each platform is a **connector** that implements one contract and registers itself. Adding Gmail, Confluence, Jira, Notion or GitHub later means writing a connector, not changing the agent. Details are in [Connector contract](#connector-contract-any-platform) below.

**Tools the LLM gets** (generated from the registered connectors):
- `search(query, sources?, where?, from?, to?)`. `sources` defaults to every connector the asker can use. `where` is the connector's own kind of container: a channel (`#payments-incident`), a folder (`Engineering/Runbooks`), a mailbox label, a Confluence space, a Jira project. The date range comes from section 1.
- `open(ref)` reads one item in full (a Drive doc, a Slack thread, an email thread, a Confluence page) when a chunk isn't enough, such as step 2 above.
- The tool description lists each connector's `where` examples, so the LLM knows what it can target.

**Merging across sources.** BM25 and vector scores aren't comparable between indices or platforms, so:
1. Merge each source's ranked list with RRF, the same `rrfFuse` used today.
2. Run Cohere rerank over the combined list. Rerank scores text against the question, so it works for any source.

**Links between sources at ingest** (makes pointers cheap to follow): each connector extracts references to **other** platforms from its text, and a shared resolver turns them into refs:
- a `docs.google.com` URL becomes `drive:<fileId>`
- `#channel` becomes `slack:<team>:<channel>`
- a Jira key like `PAY-240` becomes `jira:PAY-240`
- a Confluence URL becomes `confluence:<pageId>`

They're stored as `linked_refs`, so the agent can `open()` a linked item directly. `open()` always runs the target connector's permission checks, so a link never grants access.

**Permissions (same rules for every connector):**
- Every tool call runs **server-side as the asker**. The LLM never passes an identity, and can't widen access.
- Each connector filters **inside** its index query, never with `post_filter`, and re-checks live against the platform before returning anything, failing closed on errors. Today that's Slack membership and channel privacy, and Drive's live `getMeta` sharing check.
- Evidence the asker can't see is dropped before the LLM sees it. Only the audit log records it.

**Audit.** Log every tool call, not just the final answer, as one entry per hop to the tamper-evident `brain-audit` log from drive-connector. Move Slack's in-memory `auditLog` onto it at the same time, which also fixes the `/api/log` issue below.

**Limits.**
- At most 3–4 tool calls, a total time budget, and a stop when a call returns nothing new.
- Each step costs about 2–8s with TokenHub, so simple questions keep the single-step path. A cheap first call can decide whether a trail is needed.

**Tracing.** One Langfuse span per tool call, tagged with `source`, so the waterfall shows the trail: Drive → Drive → Slack.

**Provider.** This needs tool/function calling. Check that TokenHub `hy4-preview` supports it, or use a prompt-based JSON loop.

### Connector contract (any platform)

Each platform lives in `src/connectors/<name>/`, like `src/connectors/drive/` on drive-connector, and exports one object:

```ts
// The shape every result takes, whatever the platform.
type Evidence = {
  source: string;        // connector name: "slack", "drive", "gmail", "confluence", …
  ref: string;           // stable id "<source>:<native id>", e.g. slack:<team>:<channel>:<ts>, drive:<fileId>:<chunk>
  title: string;         // "#payments-incident" · "Payment service runbook" · email subject · page title
  location: string;      // workspace / folder path / mailbox / space / project
  author: string | null;
  time: string | null;   // ISO date the content is "from" (Slack ts, Drive modified_at, email sent date, …)
  text: string;          // the chunk the LLM reads
  permalink: string;     // opens the item in its own app
  linked_refs?: string[];// references to other items, any platform
};

type SearchFilters = { where?: string; from?: string; to?: string; size: number };

interface Connector {
  name: string;                         // "slack", "drive", …; also the `source` value and the ref prefix
  label: string;                        // shown in the UI and to the LLM: "Slack", "Google Drive"
  whereHelp: string;                    // for the tool description: "a channel, e.g. #payments"

  capabilities: {
    vectors: boolean;                   // has text_vector, so hybrid search works
    open: boolean;                      // supports open(ref)
    timeField: string | null;           // field for date filters, or null if the source has no dates
  };

  // Identity: turn a person (keyed by email) into this platform's permission labels.
  // Return null if the person has no account here: the connector is skipped for them, fail closed.
  principals(person: Person): Promise<string[] | null>;

  // Retrieval: filter by principals INSIDE the query, then re-check live against the platform.
  search(person: Person, q: string, f: SearchFilters): Promise<{ allowed: Evidence[]; audit: AuditHop }>;
  open(person: Person, ref: string): Promise<{ allowed: Evidence[]; audit: AuditHop }>;

  // Ingest: backfill + live updates into the connector's own index, with vectors if configured.
  backfill(): Promise<void>;
  startSync?(): Promise<void>;          // events, polling or webhooks; optional
  verify?(): Promise<VerifyReport>;     // index vs the platform, like `npm run verify` today
}

// src/connectors/index.ts: the only place that knows which platforms exist.
export const connectors: Connector[] = [slack, drive /*, gmail, confluence, … */]
  .filter((c) => c.enabled()); // on when its credentials are in .env / tokens file
```

**Shared rules every connector follows:**

| Concern | Rule |
|---|---|
| **Index** | One Elasticsearch index per connector (`brain-slack`, `brain-drive`, `brain-gmail`, …), with shared core fields (`text`, `text_vector`, `acl_container`, time) so hybrid search, date filters and `knnQuery` work the same everywhere. Queries always name their index. |
| **Permission labels** | `acl_container` holds labels namespaced by platform, such as `slack:<team>:channel:<id>`, `drive:user:<email>`, `gmail:mailbox:<email>`, `confluence:space:<key>`. Labels from two platforms can never collide. |
| **Identity** | People are keyed by **email**, as Slack `personId` and Drive `driveKeysFor(email)` already are. Accounts without an email get a platform-scoped ID and never match another platform. An optional mapping table covers platforms with different emails per person. |
| **Live re-check** | Required. Use the platform's API at query time (membership, sharing, mailbox ownership), batched per container, and fail closed on errors. |
| **Chunking** | The connector chunks its own content: one Slack message, a Drive doc per heading, an email per message, a Confluence page per section. |
| **Embeddings** | Use the shared `withVectors()` from `src/embeddings.ts`, so every connector uses the same model and dims. Set `capabilities.vectors` to match. |
| **Privacy switch** | Per connector: `<NAME>_EMBED=on/off` and `<NAME>_RERANK=on/off`, for sources that mustn't go to OpenAI or Cohere, such as email. |
| **Audit** | Return an `AuditHop` (allowed / dropped by re-check / denied) per call, and the agent writes it to the shared `brain-audit` log. |
| **Tracing** | Wrap `search` and `open` in `withSpan("<name>.search")` / `withSpan("<name>.open")`. |

**How future platforms map onto the contract:**

| Platform | `where` | Identity → principals | Live re-check | Time field |
|---|---|---|---|---|
| Slack (done) | channel / DM | email → workspace member + channels | channel info + membership | `ts` |
| Google Drive (drive-connector) | folder path | email → shared-with keys | `files.get` permissions | `modified_at` |
| Gmail | label / thread | email → own mailbox only | message still in mailbox | sent date |
| Confluence | space | email → space and page restrictions | page restrictions API | last edited |
| Jira | project | email → project roles and issue security | issue permission check | updated |
| Notion | workspace / page tree | email → page shares | page access API | last edited |
| GitHub | repo | GitHub login mapped to email → repo access | repo collaborator API | updated |

**A connector is done when it passes one shared conformance test suite** (`src/__tests__/connector.contract.ts`), run against each connector with fixtures:
- A person without access gets nothing: filtered in the query, not after.
- A revoked share or membership disappears on the next query, through the live re-check, before any re-index.
- A re-check error fails closed.
- Every `Evidence` has a `ref` that `open()` resolves, and a working `permalink`.
- A `linked_refs` entry to an item the person can't see stays invisible through `open()`.
- Queries name the connector's own index.

**Adding a platform, step by step:**
1. Create `src/connectors/<name>/` implementing `Connector`.
2. Add it to `src/connectors/index.ts`.
3. Add its env keys to `.env.example`.
4. Pass the conformance suite.
5. Run backfill and verify.

Nothing in the agent, Ask, Search, rerank, audit or UI changes.

### Build order
1. **Merge `drive-connector`.** Point every source query at its own index; `knnQuery` already names the Slack index.
2. **Connector contract and registry** (`src/connectors/index.ts`). Wrap Slack (today's `retrieve` in `src/search.ts`) and Drive (`retrieve` in `src/connectors/drive/query.ts`) as the first two connectors, and write the conformance suite against both.
3. **Single-step federated Ask/Search** over every registered connector (RRF, then rerank). This is useful on its own, before any agent.
4. **Embeddings for Drive chunks** (`text_vector` on `brain-drive`), so both sources get hybrid search.
5. **Agent loop** with `search` + `open`, limits, a span per hop, and audit per hop.
6. **`linked_refs`** at ingest, with the shared reference resolver.
7. **Golden dataset** with cross-source questions, like the two trails above, to measure each step.
8. **Next connector** (for example Gmail or Confluence) as the test that the contract really is platform-agnostic: it should need no changes outside its own folder.

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
3. Section 2, in its build order: merge Drive, the connector contract and registry, federated single-step Ask, Drive embeddings, then the agent loop.
4. Golden dataset with single-source and cross-source questions, to measure 1–3.
