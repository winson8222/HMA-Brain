// Per-query tracing to Langfuse (v4, OpenTelemetry-based) — the waterfall lives in the Langfuse UI.
// Everything here is a no-op unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set:
// nothing loads, no latency, and tests never touch the network.
//
// Structure per query (search or ask):
//   trace "search"/"ask"
//    ├─ embed.query            (hybrid only)
//    ├─ hybrid.fetch           (bm25 + knn legs, fuse)
//    ├─ recheck
//    ├─ rerank
//    └─ llm.chat generations   (attached in src/llm.ts)

type TracingModule = typeof import("@langfuse/tracing");

let mod: TracingModule | null | undefined;

async function getTracing(): Promise<TracingModule | null> {
  if (mod !== undefined) return mod;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    mod = null;
    return null;
  }
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
  mod = await import("@langfuse/tracing");
  return mod;
}

// Trace-level wrapper: use in search() and ask(). Sets userId so Langfuse shows per-persona traces.
export async function withTrace<T>(
  name: string,
  attrs: { userId?: string; input?: unknown; metadata?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const t = await getTracing();
  if (!t) return fn();
  return t.startActiveObservation(name, async (span: any) => {
    span?.update?.({ input: attrs.input, metadata: attrs.metadata });
    const run = () => fn();
    try {
      return attrs.userId
        ? await (t as any).propagateAttributes({ userId: attrs.userId }, run)
        : await run();
    } catch (e) {
      span?.update?.({ level: "ERROR", statusMessage: String((e as any)?.message ?? e) });
      throw e;
    }
  });
}

// Phase-level span: times one step of the pipeline and records input/output for the waterfall.
export async function withSpan<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const t = await getTracing();
  if (!t) return fn();
  return t.startActiveObservation(name, async (span: any) => {
    span?.update?.({ input });
    const out = await fn();
    // Keep outputs small: summaries only (callers pass counts/ids), never full documents.
    span?.update?.({ output: out });
    return out;
  });
}

// Attach an LLM generation to whatever trace is active (used by src/llm.ts).
// Returns undefined when tracing is off or no trace is active — a bare chat() call
// (e.g. seeding, scripts) never creates stray traces.
export async function startGeneration(input: {
  model?: string;
  input: unknown;
}): Promise<{ end: (output: { output: unknown; usageDetails?: object }) => void; fail: (message: string) => void } | undefined> {
  const t = await getTracing();
  if (!t || !t.getActiveTraceId()) return undefined;
  const gen = (t as any).startObservation(
    "llm.chat",
    { model: input.model, input: input.input },
    { asType: "generation" },
  );
  return {
    end: (output) => {
      try {
        gen.update(output).end();
      } catch {}
    },
    fail: (message) => {
      try {
        gen.update({ level: "ERROR", statusMessage: message }).end();
      } catch {}
    },
  };
}
