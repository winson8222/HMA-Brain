// Shared HTTP helpers for every router: error handling and "who is asking".
import type express from "express";
import { config } from "./config.js";
import type { AskMode } from "./search.js";
import { getSession } from "./session.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>, explain = (e: any) => String(e?.message ?? e)) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      if (!(e instanceof HttpError)) console.error(e);
      res.status(e instanceof HttpError ? e.status : 500).json({ error: e instanceof HttpError ? e.message : explain(e) });
    });

// Who is asking. Me mode: only the signed-in cookie counts, never the request body.
// Demo mode (ALLOW_IMPERSONATION=on): the UI may pick any person, for the side-by-side compare.
// `field` is the body field a demo page uses to name the person (Drive's page sends `email`).
export function asker(req: express.Request, field = "personId"): { personId: string; mode: AskMode } {
  const { asMe } = req.body ?? {};
  const picked = req.body?.[field];
  if (asMe || !config.allowImpersonation) {
    const me = getSession(req);
    if (!me) throw new HttpError(401, "Sign in first: open the Connect page and connect your Slack.");
    return { personId: me, mode: "me" };
  }
  if (!picked) throw new HttpError(400, `${field} is required`);
  return { personId: String(picked), mode: "demo" };
}
