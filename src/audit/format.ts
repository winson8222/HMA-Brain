// Plain-text rendering of audit records, for the CLIs.
import type { Access, AccessRecord, AuditRecord } from "./chain.js";

const titles = (r: AccessRecord, decision: string, withReason: boolean) =>
  r.docs
    .filter((d) => d.decision === decision)
    .map((d) => `${d.cited ? "★ " : ""}${d.title}${withReason && d.reason ? ` (${d.reason})` : ""}`)
    .join(", ") || "none";

const accessText = (a?: Access) =>
  !a ? "unknown" : `${a.labels.join(", ") || "nobody"}${a.restricted_to ? ` (restricted to: ${a.restricted_to.join(", ") || "nobody"})` : ""}`;

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "unknown");

// "changed 6:22:24 PM in drive · detected 6:22:28 PM (4s later)". Older records: the record time is detection.
type Timed = { source: string; at: string; changed_at?: string | null; detected_at?: string; modified_at?: string | null };
function times(r: Timed): string {
  const changed = r.changed_at ?? r.modified_at ?? null;
  const detected = r.detected_at ?? r.at;
  const lag = changed ? Math.max(0, Math.round((Date.parse(detected) - Date.parse(changed)) / 1000)) : null;
  return `changed in ${r.source}: ${changed ? when(changed) : "not given by the source"}   detected: ${when(detected)}${lag !== null ? ` (${lag}s later)` : ""}`;
}

function body(r: AuditRecord): string[] {
  switch (r.kind) {
    case "search":
    case "ask": {
      const lines = [`${r.actor} ${r.kind === "ask" ? "asked" : "searched"} "${r.query}"  (${r.via})`];
      if (r.keywords) lines.push(`    keywords:  ${r.keywords}`);
      if (r.answer) lines.push(`    answer:    ${r.answer.replace(/\s+/g, " ")}`);
      lines.push(`    ✓ shown:   ${titles(r, "allowed", false)}`);
      lines.push(`    ✕ withheld (not shared): ${titles(r, "denied", false)}`);
      lines.push(`    ✕ dropped by live re-check: ${titles(r, "dropped", true)}`);
      return lines;
    }
    case "permission_change":
      return [
        `permission change on ${r.source} "${r.item.title}"  (${r.via})`,
        `    ${r.summary}`,
        `    before: ${accessText(r.old_access)}`,
        `    after:  ${accessText(r.new_access)}`,
        `    ${times(r)}`,
        `    item:   ${r.item.id}${r.item.path ? `  ${r.item.path}` : ""}`,
      ];
    case "content_change":
      if (r.change === "backfill") return [`${r.source} backfill: ${r.items} item(s) indexed  (${r.via})`, `    ${r.summary}`];
      return [
        `${r.source} "${r.item.title}" ${r.change}  (${r.via})`,
        `    ${times(r)}   indexed: ${when(r.indexed_at)}`,
        `    item: ${r.item.id}${r.item.path ? `  ${r.item.path}` : ""}`,
      ];
    case "account":
      return [`${r.actor} ${r.action === "connect" ? "connected" : "disconnected"} ${r.source}${r.account ? ` (${r.account})` : ""}  (${r.via})`];
    case "admin": {
      const detail = r.detail && Object.keys(r.detail).length ? `  ${Object.entries(r.detail).map(([k, v]) => `${k}=${v}`).join(" ")}` : "";
      return [`${r.actor}: ${r.action.replace("_", " ")}${detail}  (${r.via})${r.result ? `\n    ${r.result}` : ""}`];
    }
  }
}

export function formatRecord(r: AuditRecord): string {
  const [first, ...rest] = body(r);
  return [`#${r.seq}  ${new Date(r.at).toLocaleString()}  ${first}`, ...rest, `    hash ${r.hash.slice(0, 16)}… ← ${r.prev_hash.slice(0, 16)}…`].join("\n");
}
