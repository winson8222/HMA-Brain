// Minimal OpenAI-compatible chat client. Works with any provider exposing /chat/completions
// (Tencent Hunyuan, OpenAI, a local Ollama/vLLM server, ...). Configured in .env.
import { startGeneration } from "./tracing.js";

type Msg = { role: "system" | "user" | "assistant"; content: string };

export function llmConfigured() {
  return !!(process.env.LLM_BASE_URL && process.env.LLM_MODEL);
}

export async function chat(messages: Msg[], opts: { maxTokens?: number } = {}): Promise<string> {
  if (!llmConfigured()) throw new Error("LLM not configured: set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in .env");
  const base = process.env.LLM_BASE_URL!.replace(/\/$/, "");
  const gen = await startGeneration({ model: process.env.LLM_MODEL, input: messages });
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 3000, // reasoning models spend tokens thinking before answering
      // Provider-specific options, e.g. LLM_EXTRA_BODY={"thinking":{"type":"disabled"}} for TokenHub hy4
      ...(process.env.LLM_EXTRA_BODY ? JSON.parse(process.env.LLM_EXTRA_BODY) : {}),
    }),
  });
  if (!res.ok) {
    const message = `LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`;
    gen?.fail(message);
    throw new Error(message);
  }
  const data: any = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  const usage = data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } : undefined;
  gen?.end({ output: content, ...(usage ? { usageDetails: usage } : {}) });
  return content;
}
