import { describe, expect, it, vi } from "vitest";

const search = vi.fn(async (_req: any) => ({ hits: { hits: [] } }));
vi.mock("../es.js", () => ({ es: { search, indices: { exists: async () => true, putMapping: async () => ({}) } } }));
const { docClauses, itemIdOf, queryAudit } = await import("../audit/store.js");

const lastQuery = () => search.mock.calls.at(-1)![0].query.bool;

describe("audit query filters", () => {
  it("maps chunk doc IDs to their item, and leaves item IDs alone", () => {
    expect(itemIdOf("drive:F1:3")).toBe("drive:F1");
    expect(itemIdOf("jira:acme.atlassian.net:10001:0")).toBe("jira:acme.atlassian.net:10001");
    expect(itemIdOf("jira:acme.atlassian.net:10001")).toBe("jira:acme.atlassian.net:10001"); // not a chunk: keep the issue
    expect(itemIdOf("confluence:acme:55:2")).toBe("confluence:acme:55");
    expect(itemIdOf("slack:T1:C1:1700000000.000100")).toBe("slack:T1:C1:1700000000.000100");
  });

  it("a bare Drive file ID matches searches that returned it and changes to it", () => {
    const c = JSON.stringify(docClauses("F1"));
    expect(c).toContain('{"prefix":{"allowed_ids":"drive:F1:"}}');
    expect(c).toContain('{"prefix":{"denied_ids":"drive:F1:"}}');
    expect(c).toContain('{"terms":{"item.id":["drive:F1"]}}');
  });

  it("an item ID matches its chunks in searches and the item in change records", () => {
    const c = JSON.stringify(docClauses("jira:acme:10001"));
    expect(c).toContain('{"prefix":{"allowed_ids":"jira:acme:10001:"}}');
    expect(c).toContain('"item.id":["jira:acme:10001"]');
  });

  it("title words match document titles and item titles, case-insensitively", () => {
    const c = docClauses("outage postmortem");
    expect(c).toEqual([
      { wildcard: { "docs.title": { value: "*outage postmortem*", case_insensitive: true } } },
      { wildcard: { "item.title": { value: "*outage postmortem*", case_insensitive: true } } },
    ]);
  });

  it("with a decision, only searches with that decision on the document match", () => {
    const c = JSON.stringify(docClauses("F1", "denied"));
    expect(c).not.toContain("allowed_ids");
    expect(c).not.toContain("item.");
  });

  it("combines person, kind, document and dates", async () => {
    await queryAudit({ actor: " Dave@X.com ", kind: ["permission_change"], doc: "postmortem", since: "2026-09-01", until: "2026-09-30" });
    const q = lastQuery();
    expect(q.filter).toContainEqual({ term: { actor: "dave@x.com" } });
    expect(q.filter).toContainEqual({ terms: { kind: ["permission_change"] } });
    expect(q.filter).toContainEqual({ range: { at: { gte: "2026-09-01", lte: "2026-09-30" } } });
    expect(JSON.stringify(q.filter)).toContain("*postmortem*");
  });

  it("free text searches questions, answers and change summaries", async () => {
    await queryAudit({ text: "vendor" });
    expect(lastQuery().must[0].multi_match.fields).toEqual(["query", "keywords", "answer", "summary"]);
  });
});

it("does not pair one document's title with another document's allowed decision", async () => {
  search.mockResolvedValueOnce({ hits: { hits: [{ _source: {
    seq: 1, kind: "search", allowed_ids: ["drive:B:0"], denied_ids: ["drive:A:0"],
    docs: [
      { doc_id: "drive:A:0", title: "Secret investigation", decision: "denied" },
      { doc_id: "drive:B:0", title: "Public handbook", decision: "allowed" },
    ],
  }, sort: [1] }] } } as any);
  expect(await queryAudit({ doc: "Secret investigation", decision: "allowed" })).toEqual([]);
});


it("pages past false positives to satisfy the requested number of true same-document matches", async () => {
  const wrong = { seq: 3, kind: "ask", docs: [
    { doc_id: "drive:A:0", title: "Secret", decision: "denied" },
    { doc_id: "drive:B:0", title: "Handbook", decision: "allowed" },
  ] };
  const right = { seq: 2, kind: "ask", docs: [
    { doc_id: "drive:A:0", title: "Secret", decision: "allowed" },
  ] };
  search.mockResolvedValueOnce({ hits: { hits: [{ _source: wrong, sort: [3] }] } } as any)
    .mockResolvedValueOnce({ hits: { hits: [{ _source: right, sort: [2] }] } } as any);
  expect(await queryAudit({ doc: "secret", decision: "allowed", limit: 1 })).toEqual([right]);
  expect(search.mock.calls.at(-1)![0].search_after).toEqual([3]);
});

it.each(["allowed", "denied", "dropped"] as const)("matches the requested %s decision on ID or title for existing flattened records", async decision => {
  const record = { seq: 1, kind: "ask", docs: [
    { doc_id: "drive:A:0", title: "Quarterly Review", decision },
  ] };
  for (const doc of ["A", "drive:A", "drive:A:0", "quarterly review"]) {
    search.mockResolvedValueOnce({ hits: { hits: [{ _source: record, sort: [1] }] } } as any);
    expect(await queryAudit({ doc, decision })).toEqual([record]);
  }
});
