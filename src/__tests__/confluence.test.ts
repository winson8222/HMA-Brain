import { describe, expect, it } from "vitest";
import { canSeeConfluence, confluenceFilter, confluenceKeysFor, effectiveLabels, recheck, restrictionLabels, viewLabels } from "../connectors/confluence/acl.js";
import { CHUNK_CHARS, pageChunks, pageText, pageToDocs, type SpaceAcl } from "../connectors/confluence/docs.js";
import type { RawPage } from "../connectors/confluence/client.js";

const SITE = "acme.atlassian.net";
const space: SpaceAcl = { space_id: "100", key: "ENG", name: "Engineering", view: [`confluence:${SITE}:group:g-eng`, `confluence:${SITE}:user:u-carol`], hash: "h" };

const adf = (text: string) => JSON.stringify({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const page = (over: Partial<RawPage> = {}): RawPage => ({
  id: "1",
  status: "current",
  title: "Runbook",
  spaceId: "100",
  parentId: null,
  parentType: null,
  version: { number: 3, createdAt: "2026-10-06T10:00:00Z", authorId: "u-alice" },
  body: { atlas_doc_format: { value: adf("Switch to pay-db-2.") } },
  _links: { webui: "/spaces/ENG/pages/1/Runbook" },
  ...over,
});

describe("viewLabels", () => {
  it("maps users, groups and anonymous; skips what it can't label", () => {
    const r = viewLabels(SITE, [{ type: "group", id: "g-eng" }, { type: "user", id: "u-carol" }, { type: "anonymous" }, { type: "role", id: "r1" }]);
    expect(r.labels).toEqual([`confluence:${SITE}:anyone`, `confluence:${SITE}:group:g-eng`, `confluence:${SITE}:user:u-carol`]);
    expect(r.unsupported).toEqual(["role"]);
  });
});

describe("restrictions", () => {
  it("an empty restriction means none; a page inherits its parent's effective one", () => {
    expect(restrictionLabels(SITE, { users: [], groups: [] })).toBeNull();
    expect(restrictionLabels(SITE, null)).toBeNull();
    const own = restrictionLabels(SITE, { users: ["u-alice"], groups: ["g-sec"] })!;
    expect(own).toEqual([`confluence:${SITE}:user:u-alice`, `confluence:${SITE}:group:g-sec`].sort());
    expect(effectiveLabels(null, own)).toEqual(own);
    expect(effectiveLabels(null, null)).toBeNull();
    const tighter = [`confluence:${SITE}:user:u-carol`];
    expect(effectiveLabels(tighter, own)).toEqual(tighter); // own wins over inherited
  });
});

describe("query side", () => {
  const keys = confluenceKeysFor(SITE, { accountId: "u-bob", groupIds: ["g-eng"] });
  it("keys and filter cover both layers", () => {
    expect(keys).toEqual([`confluence:${SITE}:anyone`, `confluence:${SITE}:user:u-bob`, `confluence:${SITE}:group:g-eng`]);
    expect(confluenceFilter(keys)).toHaveLength(2);
  });
  it("canSee needs the space AND (unrestricted OR the restriction)", () => {
    const open = { acl_container: space.view, restricted: false, acl_item: [] };
    const restricted = { acl_container: space.view, restricted: true, acl_item: [`confluence:${SITE}:user:u-alice`] };
    expect(canSeeConfluence(open, keys)).toBe(true);
    expect(canSeeConfluence(restricted, keys)).toBe(false);
    expect(canSeeConfluence({ ...open, acl_container: [`confluence:${SITE}:group:g-sec`] }, keys)).toBe(false);
  });
  it("recheck fails closed", () => {
    expect(recheck({ state: "ok" })).toEqual({ ok: true });
    expect(recheck(undefined).ok).toBe(false);
    expect(recheck({ state: "denied" }).ok).toBe(false);
    expect(recheck({ state: "error", error: "503" }).ok).toBe(false);
  });
});

describe("docs", () => {
  it("reads ADF text and packs paragraphs into chunks", () => {
    expect(pageText(page())).toBe("Switch to pay-db-2.");
    expect(pageText(page({ body: { atlas_doc_format: { value: "not json" } } }))).toBe("");
    const paras = Array.from({ length: 5 }, (_, i) => "p".repeat(1000) + i);
    const chunks = pageChunks(paras.join("\n\n"));
    expect(chunks.every((c) => c.length <= CHUNK_CHARS)).toBe(true);
    expect(chunks.join("\n\n")).toBe(paras.join("\n\n"));
    expect(pageChunks("")).toEqual([""]);
  });
  it("labels, permalink and hash", () => {
    const docs = pageToDocs(SITE, "https://acme.atlassian.net", page(), space, null, "Alice");
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect(d.doc_id).toBe(`confluence:${SITE}:1:0`);
    expect(d.text).toBe("Runbook\n\nSwitch to pay-db-2.");
    expect(d.acl_container).toEqual(space.view);
    expect(d.restricted).toBe(false);
    expect(d.permalink).toBe("https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Runbook");
    expect(d.updated_at).toBe("2026-10-06T10:00:00Z");
    expect(d.author_name).toBe("Alice");

    const restricted = pageToDocs(SITE, "https://acme.atlassian.net", page({ parentId: "9", parentType: "page" }), space, [`confluence:${SITE}:user:u-alice`], "Alice")[0];
    expect(restricted.restricted).toBe(true);
    expect(restricted.parent_id).toBe("9");
    expect(restricted.content_hash).not.toBe(d.content_hash); // labels are part of the hash
  });
});
