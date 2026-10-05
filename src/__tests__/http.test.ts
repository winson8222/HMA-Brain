import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { config } from "../config.js";
import { asker, HttpError } from "../http.js";
import { sign } from "../session.js";

const cookieFor = (personId: string) => `hma_session=${encodeURIComponent(sign({ p: personId }, 60_000))}`;
const req = (body: object, cookie?: string) => ({ body, headers: cookie ? { cookie } : {} }) as unknown as Request;

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof HttpError ? e.status : "other";
  }
  return "ok";
};

describe("asker (shared by Slack and Drive routes)", () => {
  const original = config.allowImpersonation;
  afterEach(() => {
    config.allowImpersonation = original;
  });

  it("Demo mode: takes the picked person from the named body field", () => {
    config.allowImpersonation = true;
    expect(asker(req({ personId: "bob@x.com" }))).toEqual({ personId: "bob@x.com", mode: "demo" });
    expect(asker(req({ email: "bob@x.com" }), "email")).toEqual({ personId: "bob@x.com", mode: "demo" });
    expect(status(() => asker(req({}), "email"))).toBe(400);
  });

  it("impersonation off: ignores the body and uses only the signed cookie", () => {
    config.allowImpersonation = false;
    expect(asker(req({ email: "carol@x.com" }, cookieFor("bob@x.com")), "email")).toEqual({ personId: "bob@x.com", mode: "me" });
    expect(status(() => asker(req({ email: "carol@x.com" }), "email"))).toBe(401);
  });

  it("rejects a forged cookie", () => {
    config.allowImpersonation = false;
    const forged = cookieFor("bob@x.com").replace(/\.[^.]+$/, ".AAAA");
    expect(status(() => asker(req({}, forged)))).toBe(401);
  });

  it("asMe uses the cookie even when impersonation is on", () => {
    config.allowImpersonation = true;
    expect(asker(req({ asMe: true, personId: "carol@x.com" }, cookieFor("bob@x.com")))).toEqual({ personId: "bob@x.com", mode: "me" });
  });
});
