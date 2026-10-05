// Jira as a connector: wraps the permission-aware retrieval in query.ts.
// Loaded only when Jira is configured (see ../index.ts).
import type { Connector, Evidence } from "../types.js";
import { bodyOf, retrieve, snippetOf } from "./query.js";

export const jira: Connector = {
  name: "jira",
  label: "Jira",

  async retrieve(personId, q, opts) {
    // Jira access is by the Atlassian account the person linked with Connect Jira. Not linked: nothing (fail closed).
    const { allowed, audit } = await retrieve(personId, q, { size: opts.size, onePerIssue: opts.purpose === "search", vectorQuery: opts.vectorQuery });
    return {
      allowed: allowed.map((h): Evidence => {
        const d = h._source!;
        return {
          source: "jira",
          ref: d.doc_id,
          title: `${d.issue_key}: ${d.summary}`,
          location: [d.project_name, d.status].filter(Boolean).join(" · "),
          author: d.reporter_name,
          time: d.updated_at,
          text: bodyOf(d) || d.summary,
          snippet: snippetOf(h),
          permalink: d.permalink,
          private: d.restricted,
        };
      }),
      audit,
    };
  },

  describe: (e) => `${e.title} · ${e.location} · updated ${e.time?.slice(0, 10) ?? "unknown"}`,
  answerHint: "Issue excerpts show the status at the time shown; cite the issue key (e.g. PAY-240) when you mention an issue.",
};
