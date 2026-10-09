// Audit API, admins only: query the log (S5) and check the hash chain.
// Looking at the log is itself recorded: who watches the watchers.
import express from "express";
import { requireAdmin } from "../admin.js";
import { parseKinds, type AuditKind, type Decision } from "./chain.js";
import { recordAudit } from "./record.js";
import { queryAudit, verifyAudit, type AuditFilter } from "./store.js";

export const auditRouter = express.Router();

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const DECISIONS = new Set(["allowed", "dropped", "denied"]);

auditRouter.get("/api/audit", requireAdmin, async (req, res) => {
  try {
    const decision = str(req.query.decision);
    const kind: AuditKind[] | undefined = parseKinds(str(req.query.kind));
    const filter: AuditFilter = {
      actor: str(req.query.actor),
      doc: str(req.query.doc),
      kind,
      decision: decision && DECISIONS.has(decision) ? (decision as Decision) : undefined,
      since: str(req.query.since),
      until: str(req.query.until),
      text: str(req.query.text),
      limit: Number(req.query.limit) || 30,
    };
    const records = await queryAudit(filter);
    const detail = Object.fromEntries(
      Object.entries({ ...filter, kind: kind?.join(","), limit: undefined }).filter(([, v]) => v !== undefined && v !== ""),
    ) as Record<string, string>;
    await recordAudit({ kind: "admin", actor: "admin", via: "web", action: "audit_query", detail, result: `${records.length} record(s)` });
    res.json(records);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

auditRouter.get("/api/audit/verify", requireAdmin, async (_req, res) => {
  try {
    const v = await verifyAudit();
    await recordAudit({
      kind: "admin",
      actor: "admin",
      via: "web",
      action: "audit_verify",
      result: v.ok ? `intact: ${v.checked} records, head #${v.head?.seq ?? 0}` : `BROKEN: ${v.problems.length} problem(s)`,
    });
    res.json(v);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
