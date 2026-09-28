// "Who am I" for Me mode: a signed cookie holding the person's ID (their email), set by Connect.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.js";

const COOKIE = "hma_session";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const mac = (v: string) => createHmac("sha256", config.sessionSecret).update(v).digest("base64url");

// Tamper-proof token: base64url(JSON) + "." + HMAC. Also used for the OAuth `state`.
export function sign(data: object, ttlMs: number): string {
  const v = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlMs })).toString("base64url");
  return `${v}.${mac(v)}`;
}

export function verify<T>(token: string | undefined): T | undefined {
  const [v, m] = (token ?? "").split(".");
  if (!v || !m) return undefined;
  const a = Buffer.from(m), b = Buffer.from(mac(v));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const data = JSON.parse(Buffer.from(v, "base64url").toString());
  return data.exp > Date.now() ? (data as T) : undefined;
}

export function setSession(res: Response, personId: string) {
  res.cookie(COOKIE, sign({ p: personId }, MAX_AGE_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicUrl.startsWith("https://"),
    maxAge: MAX_AGE_MS,
  });
}

export function getSession(req: Request): string | undefined {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE)?.[1];
  return verify<{ p: string }>(raw && decodeURIComponent(raw))?.p;
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE);
}
