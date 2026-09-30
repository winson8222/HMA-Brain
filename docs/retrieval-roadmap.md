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
- [ ] **Date-range filters.** Turn time phrases ("tomorrow", "last week", "in the last 3 days") into a range on the `ts` field, inside the query next to the permission filter, in both the BM25 and kNN legs. Add a mild recency boost.
- [ ] **Resolve relative dates at ingest.** When indexing, work out the actual dates behind "Friday" or "tomorrow" from the message's post time and store them as `mentioned_dates`. "What's on 2 Oct?" can then match. Needs a mapping change and a backfill.

## 2. Multi-step retrieval ("Agentic Ask")

**Problem.** Ask runs one retrieval, then one answer. Some questions need a trail. Example: *"details on tomorrow's meeting"* finds "agenda is in #planning", which says "room booked, see #facilities", and so on until the picture is complete.

**Design:**
```
question → LLM ──calls──▶ search(query, channel?, from?, to?) ─┐
              ◀── results (only what the asker may see) ───────┘
           …repeat until it has enough (max ~4 calls)…
           → final answer, citing every step
```
- Give the LLM a `search` tool, with optional `channel` and date filters, so it can follow pointers such as "see #planning".
- **Permissions:** the server always runs the tool **as the asker**, through the existing `retrieve(personId, …)`. The LLM can't widen access, and it only ever sees filtered results.
- **Limits:** at most 3–4 tool calls, a total time budget, and a stop when a call returns nothing new. Each step costs about 2–8s with TokenHub, so fall back to single-step Ask for simple questions.
- **Tracing:** one Langfuse span per tool call, so the trail is visible in the timeline.
- Needs tool/function calling from the LLM provider. Check that TokenHub `hy4-preview` supports it, or use a prompt-based JSON loop.

## 3. Other improvements

| Idea | What it fixes | Effort |
|---|---|---|
| **Pull in thread and nearby messages** | A match is often a reply or "see above". Add the thread parent and replies (`thread_ts` is already indexed) and neighbouring messages before calling the LLM. | Small |
| **Faster permission re-check** | About 3s per query: `getChannel(…, true)` runs once per hit, one after another. Fetch each distinct channel once, in parallel. Just as strict, since every channel is still fetched fresh. | Small |
| **Cache question embeddings** | Repeated questions skip the OpenAI call. | Small |
| **Rerank on the original question** | In Ask, rerank scores against the extracted keywords. The full question suits Cohere better. | Small |
| **More candidates in keyword-only mode** | Keyword-only fetches just `size` candidates, so rerank barely helps. Fetch `hybridCandidates` there too. | Small |
| **Chunk long content** | One Slack message is one doc today. Long posts and Drive files need chunking. | Medium |
| **Golden dataset + eval harness** | Measure each change (hit rate at k, answer correctness) across `RETRIEVAL_MODE`, `RERANK` and `MULTI_QUERY` instead of guessing. | Medium |

## Known issues to fix alongside

- **`/api/log` has no access control.** It returns every person's questions and the text of withheld private-channel messages (DM text is already hidden). Put it behind an admin check, like `requireAdmin` on `drive-connector`, or stop storing withheld text.
- **`drive-connector` isn't merged** into this branch yet.

## Suggested order

1. Today's date in the prompts, then date-range filters: small and very visible in a demo.
2. Thread and nearby-message context, and the faster re-check.
3. Agentic Ask.
4. Golden dataset, to measure 1–3.
