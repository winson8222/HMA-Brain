# Retrieval and LLM implementation

The main Search and Ask interface retrieves indexed company content from configured Slack, Google Drive, Jira and Confluence connectors. Elasticsearch retrieves candidates; models help rewrite questions, match meaning, rank evidence and generate answers. Access is enforced by connector code before evidence reaches the reranker or answer model.

## Search and Ask flow

1. **Resolve identity and sources.** The server uses the signed-in person, or an explicitly enabled demo persona, and selects the requested connectors. Connectors run in parallel. A failing connector contributes no evidence and is reported as unavailable; other sources can still return results.
2. **Prepare the query.** Search uses the entered text directly. Ask calls the chat model to produce 3–8 search keywords, including likely synonyms. If rewriting fails, is empty or returns more than 20 words, the original question is used. Ask keeps the original question for semantic search and reranking.
3. **Retrieve within each source.** Keyword search uses Elasticsearch's lexical ranking (BM25). Optional hybrid retrieval also embeds the query and searches indexed content vectors. Both searches apply the asker's permission filters inside the query. Their ranked lists are combined using reciprocal rank fusion, which combines rank positions rather than comparing raw scores.
4. **Recheck access.** Each connector applies its supported current-access rules and withholds evidence that fails. Slack channel checks use fresh membership and channel information; DMs use participant labels. Drive compares fresh crawler-read sharing metadata with the asker's access keys. Jira and Confluence check access for the linked Atlassian account. See the [permission implementation](permissions-and-sync.md) for details and limits.
5. **Merge and rerank.** The shared layer combines the permitted source rankings using reciprocal rank fusion. If enabled, Cohere reranks these excerpts against the original query. The main interface selects up to 10 Search results or 8 Ask excerpts. A reranker failure preserves the merged order.
6. **Generate the answer.** Ask supplies numbered excerpts, source descriptions, the question and today's date in the configured company timezone to the chat model. The answer rules request facts supported only by those excerpts, numbered citations and a short response. With no permitted evidence, the app returns “I don't have information on that.” without an answer-generation call. These are prompt instructions, not a separate factual-verification pass.
7. **Audit before returning.** Search records the query and document access decisions. Ask additionally records rewritten keywords, the answer and which retrieved documents were cited. Only cited excerpts become answer source cards. If answer generation fails, the failure is audited and surfaced as an error. An audit write failure blocks either response.

Admin-only metadata queries can record withheld items, but their metadata never enters the answer context or the asker's response. Audit decisions cover retrieved candidates and a limited metadata query; they are not an exhaustive list of every matching document.

## Model roles and source coverage

| Capability | Implemented behavior |
| --- | --- |
| Chat model | Rewrites Ask questions into keywords and generates cited answers across all selected sources |
| Embedding model | Creates content and query vectors for optional semantic retrieval across all four connectors |
| Multi-query expansion | An optional chat call produces alternative phrasings for Slack's semantic search; the original query and variants are embedded and their result lists fused |
| Reranker | Optional Cohere call ranks already-permitted evidence once across the merged source list |

Multi-query expansion currently applies only to Slack and can run for Search as well as Ask when hybrid mode and the chat model are configured. It falls back to the original query if paraphrasing fails. Drive, Jira and Confluence each use a single semantic query.

Content is embedded during indexing when embeddings are configured. Failed embedding batches remain searchable by keywords; a later backfill can populate missing vectors. Query-embedding failures fall back to keyword retrieval. Drive, Jira and Confluence also catch vector-search failures locally; a Slack vector-search request failure can make Slack unavailable for that federated request.

## Configuration

Set these values in `.env` using [the example configuration](../../.env.example). Use the [platform setup guides](../README.md) to configure and import each source first.

| Setting | Purpose and default |
| --- | --- |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | Chat endpoint, model and provider credentials; the client calls `/chat/completions` |
| `RETRIEVAL_MODE` | `lexical` or `hybrid`; defaults to hybrid when an embedding model and positive dimensions are configured, otherwise lexical |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMS` | Embedding model and output size matching the index vector mapping |
| `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` | Embedding endpoint and credentials; when unset, fall back to the corresponding `LLM_*` values; the client calls `/embeddings` |
| `MULTI_QUERY` | Slack expansion: unset, `off` or `0` disables it; `on` requests two paraphrases; integers `1`–`5` choose the count |
| `RERANK`, `COHERE_API_KEY`, `COHERE_MODEL` | `RERANK=on` or `off` overrides automatic enablement when a Cohere key exists; default model is `rerank-v3.5` |

Configure embeddings before the initial import so the source indexes receive the correct vector mappings. If changing embedding models or dimensions on an existing installation, review the source-specific backfill/reset effects in the [command reference](commands.md#index-resets-are-different) before rebuilding. Query and indexed vectors must use the same model and dimensions.

Search can run without a chat model when multi-query expansion is disabled. Ask needs a configured chat model to generate an answer from evidence. The separate Drive-only page and CLI reuse Drive retrieval but have their own answer path; the shared cross-source reranking and date context described above belong to the main interface.

## Implementation map

| Code | Responsibility |
| --- | --- |
| [Federated retrieval](../../src/federated.ts) | Source selection, keyword rewrite, cross-source fusion, reranking, answer context, citations and required audit writes |
| [Connector registry](../../src/connectors/index.ts) | Which configured sources participate |
| [Slack retrieval](../../src/search.ts) | Keyword/vector queries, multi-query expansion and access rechecks |
| [Drive](../../src/connectors/drive/query.ts), [Jira](../../src/connectors/jira/query.ts), [Confluence](../../src/connectors/confluence/query.ts) | Source-specific hybrid queries and access rechecks |
| [Hybrid helpers](../../src/hybrid.ts), [embeddings](../../src/embeddings.ts), [multi-query](../../src/multiQuery.ts), [reranking](../../src/rerank.ts) | Retrieval configuration, vectors, rank fusion and model-assisted ranking |
| [Chat client](../../src/llm.ts), [answer rules](../../src/askRules.ts), [prompts](../../src/prompts.ts) | Chat calls with timeouts/retries and answer instructions, optionally supplied through Langfuse |

The current implementation retrieves a bounded set of indexed excerpts. Following references through an iterative search/open loop, expanding nearby thread context and adding query date filters remain future work (see the README).
