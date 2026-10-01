// Minimal OpenAI-compatible chat client. Works with any provider exposing /chat/completions
// (Tencent Hunyuan, OpenAI, a local Ollama/vLLM server, ...). Configured in .env.
import { startGeneration } from "./tracing.js";

type Msg = { role: "system" | "user" | "assistant"; content: string };

// A provider call that never returns would otherwise leave the UI loading forever.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 15_000);
// Some providers (e.g. TokenHub hy4-preview) occasionally hold a request for minutes; a fresh request usually answers in seconds.
const ATTEMPTS = Number(process.env.LLM_ATTEMPTS ?? 3);

export function llmConfigured() {
  return !!(process.env.LLM_BASE_URL && process.env.LLM_MODEL);
}

async function callOnce(messages: Msg[], maxTokens: number): Promise<string> {
  const base = process.env.LLM_BASE_URL!.replace(/\/$/, "");
  const gen = await startGeneration({ model: process.env.LLM_MODEL, input: messages });
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        // Provider-specific options, e.g. LLM_EXTRA_BODY={"thinking":{"type":"disabled"}} for TokenHub hy4
        ...(process.env.LLM_EXTRA_BODY ? JSON.parse(process.env.LLM_EXTRA_BODY) : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const usage = data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } : undefined;
    gen?.end({ output: content, ...(usage ? { usageDetails: usage } : {}) });
    return content;
  } catch (e: any) {
    // Close the generation on any failure (HTTP error, timeout, network) so the trace never shows it as still running.
    gen?.fail(e?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : String(e?.message ?? e));
    throw e;
  }
}

export async function chat(messages: Msg[], opts: { maxTokens?: number } = {}): Promise<string> {
  if (!llmConfigured()) throw new Error("LLM not configured: set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in .env");
  const maxTokens = opts.maxTokens ?? 3000; // reasoning models spend tokens thinking before answering
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      return await callOnce(messages, maxTokens);
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError";
      console.warn(`LLM call ${timedOut ? "timed out" : "failed"} after ${((Date.now() - t0) / 1000).toFixed(1)}s (attempt ${attempt}/${ATTEMPTS})`);
      // Retry timeouts and provider/network hiccups; give up after the last attempt.
      if (attempt >= ATTEMPTS || (!timedOut && /LLM error 4\d\d/.test(String(e?.message)))) {
        throw timedOut ? new Error("The LLM didn't respond in time. Try again.") : e;
      }
    }
  }
}
