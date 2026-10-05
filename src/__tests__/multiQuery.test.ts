import { describe, expect, it } from "vitest";
import { parseParaphrases } from "../multiQuery.js";

describe("parseParaphrases", () => {
  it("strips bullets/numbering and caps at n", () => {
    const reply = "1. The payment system failed\n- reason for the payment outage\n3) why payments broke\nextra";
    expect(parseParaphrases(reply, 2, "why did payments fail")).toEqual([
      "The payment system failed",
      "reason for the payment outage",
    ]);
  });

  it("drops empties, duplicates, and the original question (case-insensitive)", () => {
    const reply = ["", "Why did payments fail?", "Why Did Payments Fail?", "server down"].join("\n");
    expect(parseParaphrases(reply, 3, "why did payments fail")).toEqual(["server down"]);
  });
});
