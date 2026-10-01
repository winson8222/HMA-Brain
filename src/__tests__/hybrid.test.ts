import { describe, expect, it } from "vitest";
import { knnQuery, resolveMultiQuery, resolveRerank, resolveRetrievalMode, rrfFuse } from "../hybrid.js";

describe("rrfFuse", () => {
  it("sums 1/(k+rank) over both legs, rank starting at 1", () => {
    const fused = rrfFuse([["a", "b"], ["b", "a"]], 60);
    expect(fused[0].id).toBe("a"); // tie → first-seen in the first list wins
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[1].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
  });

  it("ranks a doc present in both lists above one in a single list", () => {
    const fused = rrfFuse([["a", "b"], ["a", "c"]], 60);
    expect(fused[0].id).toBe("a");
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a doc found by only one leg", () => {
    const fused = rrfFuse([["x"]], 60);
    expect(fused).toEqual([{ id: "x", score: 1 / 61 }]);
  });

  it("dedups by id within a list", () => {
    const fused = rrfFuse([["a", "a", "b"]], 60);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it("breaks ties deterministically by first appearance", () => {
    const a = rrfFuse([["p", "q"]], 60);
    const b = rrfFuse([["p", "q"]], 60);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(a.map((f) => f.score)).toEqual(b.map((f) => f.score));
  });
});

describe("knnQuery", () => {
  // Security regression guard: the permission filter must live INSIDE the knn clause
  // (developer-guide rule) and post_filter must never appear.
  it("puts the ACL filter inside the knn clause and never uses post_filter", () => {
    const body = knnQuery([0.1, 0.2], ["slack:ws:T1:member"], 50, 100) as any;
    expect(body.knn.field).toBe("text_vector");
    expect(body.knn.query_vector).toEqual([0.1, 0.2]);
    expect(body.knn.k).toBe(50);
    expect(body.knn.num_candidates).toBe(100);
    expect(body.knn.filter).toEqual([{ terms: { acl_container: ["slack:ws:T1:member"] } }]);
    expect(body).not.toHaveProperty("post_filter");
    expect(JSON.stringify(body)).not.toContain("post_filter");
  });
});

describe("mode and rerank resolution", () => {
  it("RETRIEVAL_MODE overrides the default", () => {
    process.env.RETRIEVAL_MODE = "lexical";
    expect(resolveRetrievalMode()).toBe("lexical");
    process.env.RETRIEVAL_MODE = "hybrid";
    expect(resolveRetrievalMode()).toBe("hybrid");
    delete process.env.RETRIEVAL_MODE;
  });

  it("defaults to lexical without embedding config", () => {
    delete process.env.RETRIEVAL_MODE;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMS;
    expect(resolveRetrievalMode()).toBe("lexical");
  });

  it("defaults to hybrid once a model and dims are configured", () => {
    delete process.env.RETRIEVAL_MODE;
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.EMBEDDING_DIMS = "1536";
    expect(resolveRetrievalMode()).toBe("hybrid");
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMS;
  });

  it("RERANK=off beats a present COHERE_API_KEY; unset defaults to the key", () => {
    process.env.COHERE_API_KEY = "test-key";
    delete process.env.RERANK;
    expect(resolveRerank()).toBe(true);
    process.env.RERANK = "off";
    expect(resolveRerank()).toBe(false);
    process.env.RERANK = "on";
    expect(resolveRerank()).toBe(true);
    delete process.env.COHERE_API_KEY;
    delete process.env.RERANK;
    expect(resolveRerank()).toBe(false);
  });
});

describe("MULTI_QUERY resolution", () => {
  const cases: [string | undefined, number][] = [
    [undefined, 0],
    ["off", 0],
    ["0", 0],
    ["on", 2],
    ["1", 1],
    ["3", 3],
    ["5", 5],
    ["6", 0], // above cap
    ["2.5", 0], // not an integer
    ["banana", 0],
  ];
  it.each(cases)("MULTI_QUERY=%s → %i", (env, expected) => {
    if (env === undefined) delete process.env.MULTI_QUERY;
    else process.env.MULTI_QUERY = env;
    expect(resolveMultiQuery()).toBe(expected);
    delete process.env.MULTI_QUERY;
  });
});
