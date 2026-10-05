// Admin-only routes (audit log, connecting a source) require the ADMIN_TOKEN from .env in the
// x-admin-token header. Without ADMIN_TOKEN set, they're switched off.
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const want = process.env.ADMIN_TOKEN ?? "";
  if (want.length < 16) {
    return void res.status(403).json({ error: "Admin features are off: set ADMIN_TOKEN (16+ characters) in .env and restart." });
  }
  const got = Buffer.from(req.get("x-admin-token") ?? "");
  const ok = got.length === want.length && timingSafeEqual(got, Buffer.from(want));
  if (!ok) return void res.status(401).json({ error: "Admin token required" });
  next();
}
