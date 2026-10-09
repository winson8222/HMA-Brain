// Confluence as a connector: wraps the permission-aware retrieval in query.ts.
// Loaded only when Confluence is configured (see ../index.ts).
import type { Connector, Evidence } from "../types.js";
import { bodyOf, retrieve, snippetOf } from "./query.js";

export const confluence: Connector = {
  name: "confluence",
  label: "Confluence",

  async retrieve(personId, q, opts) {
    // Access is by the Atlassian account the person linked with Connect Jira. Not linked: nothing (fail closed).
    const { allowed, audit } = await retrieve(personId, q, { size: opts.size, onePerPage: opts.purpose === "search", vectorQuery: opts.vectorQuery });
    return {
      allowed: allowed.map((h): Evidence => {
        const d = h._source!;
        return {
          source: "confluence",
          ref: d.doc_id,
          title: d.title,
          location: d.space_name,
          author: d.author_name,
          time: d.updated_at,
          text: bodyOf(d) || d.title,
          snippet: snippetOf(h),
          permalink: d.permalink,
          private: d.restricted,
        };
      }),
      audit,
    };
  },

  describe: (e) => `${e.title} · ${e.location} space · updated ${e.time?.slice(0, 10) ?? "unknown"}`,
  answerHint: "Confluence pages are the documented decision or procedure; cite the page title and may be newer than messages that discuss it.",
};
