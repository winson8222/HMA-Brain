import { describe, expect, it } from "vitest";
import { applyRerankOrder } from "../rerank.js";

const docs = [{ text: "a" }, { text: "b" }, { text: "c" }];

describe("applyRerankOrder", () => {
  it("reorders items by relevance score, best first", () => {
    const out = applyRerankOrder(docs, [
      { index: 2, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.5 },
      { index: 1, relevance_score: 0.7 },
    ]);
    expect(out.map((r) => r.item.text)).toEqual(["c", "b", "a"]);
    expect(out[0].score).toBe(0.9);
  });

  it("drops out-of-range indices instead of crashing", () => {
    const out = applyRerankOrder(docs, [
      { index: 99, relevance_score: 1 },
      { index: -1, relevance_score: 1 },
      { index: 1, relevance_score: 0.4 },
    ]);
    expect(out.map((r) => r.item.text)).toEqual(["b"]);
  });

  it("returns an empty list for empty results", () => {
    expect(applyRerankOrder(docs, [])).toEqual([]);
  });
});
