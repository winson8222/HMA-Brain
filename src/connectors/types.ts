// The contract every source (Slack, Drive, later Jira, Gmail, …) implements, so Search and Ask can run
// over any mix of them without knowing which platforms exist. See docs/retrieval-roadmap.md.
import type { AuditDoc } from "../audit/chain.js";

// One permitted piece of content, whatever the platform.
export type Evidence = {
  source: string; // connector name, e.g. "slack", "drive"
  ref: string; // stable unique id, e.g. slack:<team>:<channel>:<ts>, drive:<fileId>:<chunk>
  title: string; // "#payments-incident", "Payment service runbook"
  location: string; // workspace, folder path, project…
  author: string | null;
  time: string | null; // ISO date the content is "from"
  text: string; // plain text: what the LLM and the reranker read
  snippet: string; // HTML: escaped text with <mark> highlights, for the UI
  permalink: string; // opens the item in its own app
  private: boolean; // shown with a lock in the UI (private channel, DM, restricted file)
};

export type Retrieved = {
  allowed: Evidence[]; // already filtered in the query AND re-checked live: safe to show and to send to the LLM
  audit: AuditDoc[]; // allowed / dropped / denied, for the admin audit log only
};

export type RetrieveOpts = {
  size: number;
  purpose: "search" | "ask"; // search: one result per item; ask: several chunks per item are fine
  vectorQuery?: string; // the raw question, when `q` is an LLM keyword rewrite
};

export interface Connector {
  name: string; // also Evidence.source and the value clients pass in `sources`
  label: string; // "Slack", "Google Drive"
  // Search as this person. Must filter by their permissions inside the index query, re-check live
  // against the platform, and fail closed. A person with no account on this platform gets nothing.
  retrieve(personId: string, q: string, opts: RetrieveOpts): Promise<Retrieved>;
  // One line placed before each excerpt in the Ask prompt, e.g. "Company A · #payments · Alice · 2026-09-25 10:04".
  describe(e: Evidence): string;
  // Optional extra instruction for the Ask prompt when this source contributed excerpts.
  answerHint?: string;
}
