// Slack as a connector: wraps the permission-aware retrieval in src/search.ts.
import type { AuditDoc } from "../../audit/chain.js";
import { retrieve, toResult, type LoggedDoc } from "../../search.js";
import { localDateTime } from "../../time.js";
import type { Connector, Evidence } from "../types.js";

const where = (d: { kind: string; channel: string }) => (d.kind === "channel" ? `#${d.channel}` : d.channel);

const auditDoc = (d: LoggedDoc, decision: AuditDoc["decision"], reason?: string): AuditDoc => ({
  doc_id: d.id,
  source: "slack",
  title: where(d),
  path: d.workspace,
  decision,
  ...(reason ? { reason } : {}),
});

export const slack: Connector = {
  name: "slack",
  label: "Slack",

  async retrieve(personId, q, opts) {
    // Rerank happens once over the merged list from every source, so Slack skips its own.
    const { allowed, audit } = await retrieve(personId, q, opts.size, { vectorQuery: opts.vectorQuery, rerank: false });
    return {
      allowed: allowed.map((h): Evidence => {
        const d = h._source!;
        const r = toResult(h);
        return {
          source: "slack",
          ref: h._id!,
          title: where(r),
          location: d.team_name,
          author: d.user_name,
          time: d.ts,
          text: d.text,
          snippet: r.snippet,
          permalink: d.permalink,
          private: d.is_private || d.kind !== "channel",
        };
      }),
      audit: [
        ...audit.allowed.map((d) => auditDoc(d, "allowed")),
        ...audit.droppedByRecheck.map((d) => auditDoc(d, "dropped", "failed the live Slack re-check")),
        ...audit.denied.map((d) => auditDoc(d, "denied", "not a member of this conversation")),
      ],
    };
  },

  describe: (e) => `${e.location} · ${e.title} · ${e.author ?? "unknown"} · ${localDateTime(e.time)}`,
};
