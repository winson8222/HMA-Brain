// Ask: permission-filtered retrieval + an LLM answer grounded only in what the user may see.
import { chat } from "./llm.js";
import { getPrompt } from "./prompts.js";
import { logEntry, retrieve, toResult, type AskMode, type Result } from "./search.js";
import { withTrace } from "./tracing.js";

export const NO_INFO = "I don't have information on that.";

export type Answer = { answer: string; keywords: string; sources: (Result & { n: number })[] };

// Questions are full of words like "what" and "the"; turn them into search keywords first.
async function toKeywords(question: string): Promise<string> {
  try {
    const k = await chat(
      [
        {
          role: "system",
          content:
            "Rewrite the user's question as 3-8 search keywords for a keyword search over Slack messages. Include likely synonyms. Output only the keywords separated by spaces.",
        },
        { role: "user", content: question },
      ],
      { maxTokens: 1500 },
    );
    return k.replace(/[\n"]/g, " ").trim() || question;
  } catch {
    return question;
  }
}

export async function ask(personId: string, question: string, mode: AskMode): Promise<Answer> {
  return withTrace("ask", { userId: personId, input: { query: question }, metadata: { mode } }, () =>
    askInner(personId, question, mode),
  );
}

async function askInner(personId: string, question: string, mode: AskMode): Promise<Answer> {
  const keywords = await toKeywords(question);
  // Semantic leg embeds the raw question; the keyword rewrite drives the lexical leg.
  const { allowed, audit } = await retrieve(personId, keywords, 8, { vectorQuery: question });

  let answer = NO_INFO;
  if (allowed.length) {
    // Only messages this user is allowed to see are ever put in the prompt.
    const context = allowed
      .map((h, i) => {
        const d = h._source!;
        const where = d.kind === "channel" ? `#${d.channel_name}` : d.channel_name;
        return `[${i + 1}] ${d.team_name} · ${where} · ${d.user_name} · ${d.ts.slice(0, 16).replace("T", " ")}\n${d.text}`;
      })
      .join("\n\n");
    answer = await chat([
      { role: "system", content: await getPrompt("ask-answer-rules") },
      { role: "user", content: `Messages:\n\n${context}\n\nQuestion: ${question}` },
    ]);
  }

  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const sources = allowed
    .map((h, i) => ({ n: i + 1, ...toResult(h) }))
    .filter((s) => cited.has(s.n));

  logEntry({ kind: "ask", mode, personId, query: question, keywords, answer, ...audit });
  return { answer, keywords, sources };
}
