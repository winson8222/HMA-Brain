// Audit API, admins only: query the log (S5) and check the hash chain.
import express from "express";
import { requireAdmin } from "../admin.js";
import type { Decision } from "./chain.js";
import { queryAudit, verifyAudit } from "./store.js";

export const auditRouter = express.Router();

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const DECISIONS = new Set(["allowed", "dropped", "denied"]);

auditRouter.get("/api/audit", requireAdmin, async (req, res) => {
  try {
    const decision = str(req.query.decision);
    res.json(
      await queryAudit({
        actor: str(req.query.actor),
        doc: str(req.query.doc),
        decision: decision && DECISIONS.has(decision) ? (decision as Decision) : undefined,
        since: str(req.query.since),
        until: str(req.query.until),
        text: str(req.query.text),
        limit: Number(req.query.limit) || 30,
      }),
    );
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

auditRouter.get("/api/audit/verify", requireAdmin, async (_req, res) => {
  try {
    res.json(await verifyAudit());
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
