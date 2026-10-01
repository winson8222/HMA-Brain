import { describe, expect, it } from "vitest";
import { startGeneration, withSpan, withTrace } from "../tracing.js";

// With no LANGFUSE_* env, tracing must be a transparent no-op: the callback's value
// comes back, nothing throws, and no generation is created.
describe("tracing without Langfuse configured", () => {
  it("withTrace passes the value through", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    await expect(withTrace("test", { userId: "u1" }, async () => 42)).resolves.toBe(42);
  });

  it("withSpan propagates errors untouched", async () => {
    await expect(
      withSpan("test", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("startGeneration is undefined with no active trace", async () => {
    await expect(startGeneration({ input: [] })).resolves.toBeUndefined();
  });
});
