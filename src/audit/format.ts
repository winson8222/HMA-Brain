// Plain-text rendering of audit records, for the CLIs.
import type { AuditRecord } from "./chain.js";

const titles = (r: AuditRecord, decision: string, withReason: boolean) =>
  r.docs
    .filter((d) => d.decision === decision)
    .map((d) => `${d.cited ? "★ " : ""}${d.title}${withReason && d.reason ? ` (${d.reason})` : ""}`)
    .join(", ") || "none";

export function formatRecord(r: AuditRecord): string {
  const when = new Date(r.at).toLocaleString();
  const lines = [`#${r.seq}  ${when}  ${r.actor} ${r.kind === "ask" ? "asked" : "searched"} "${r.query}"  (${r.via})`];
  if (r.keywords) lines.push(`    keywords:  ${r.keywords}`);
  if (r.answer) lines.push(`    answer:    ${r.answer.replace(/\s+/g, " ")}`);
  lines.push(`    ✓ shown:   ${titles(r, "allowed", false)}`);
  lines.push(`    ✕ withheld (not shared): ${titles(r, "denied", false)}`);
  lines.push(`    ✕ dropped by live re-check: ${titles(r, "dropped", true)}`);
  lines.push(`    hash ${r.hash.slice(0, 16)}… ← ${r.prev_hash.slice(0, 16)}…`);
  return lines.join("\n");
}
