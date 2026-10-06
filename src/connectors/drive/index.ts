// Google Drive as a connector: wraps the permission-aware retrieval in query.ts.
// Loaded only when the Google app is configured (see ../index.ts).
import type { Connector, Evidence } from "../types.js";
import { localDateOf } from "../../time.js";
import { isRealEmail } from "./people.js";
import { bodyOf } from "./prompt.js";
import { retrieve, toResult } from "./query.js";

export const drive: Connector = {
  name: "drive",
  label: "Google Drive",

  async retrieve(personId, q, opts) {
    // Drive access is by email. A person known only by a workspace-scoped Slack ID has no Google
    // identity, so they get nothing here: fail closed.
    if (!isRealEmail(personId)) return { allowed: [], audit: [] };
    const { allowed, audit } = await retrieve(personId.toLowerCase(), q, { size: opts.size, onePerFile: opts.purpose === "search", vectorQuery: opts.vectorQuery });
    return {
      allowed: allowed.map((h): Evidence => {
        const d = h._source!;
        const r = toResult(h);
        return {
          source: "drive",
          ref: d.doc_id,
          title: d.title,
          location: d.heading ? `${d.path} · ${d.heading}` : d.path,
          author: d.owner_email,
          time: d.modified_at,
          text: bodyOf(d) || d.title,
          snippet: r.snippet,
          permalink: d.permalink,
          private: false,
        };
      }),
      audit,
    };
  },

  describe: (e) => `"${e.title}" · ${e.location} · updated ${localDateOf(e.time)}`,
  answerHint: "Document excerpts can be out of date: when two disagree, prefer the most recently updated one.",
};
