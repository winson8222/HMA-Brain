// Client-supplied conversation history for multi-turn Ask. Untrusted input: it steers what is
// searched and gives the model context, but it can never widen access — that still comes only
// from the asker's identity, the index filter and the live re-check (see src/federated.ts).

import { randomBytes } from "node:crypto";

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export const HISTORY_MAX_TURNS = 6;
const CONTENT_MAX_CHARS = 1500;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// A conversation ID the client may pick (or one we generate): short, URL- and ES-safe.
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Length-safe: /[A-Za-z0-9_-]{8,64}/ via base64url (24 bytes → 32 chars).
export const newConversationId = () => randomBytes(24).toString("base64url");

function cleanContent(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL_CHARS, "").trim();
  if (!s) return null;
  return s.length > CONTENT_MAX_CHARS ? `${s.slice(0, CONTENT_MAX_CHARS)}…` : s;
}

// Keep only user/assistant turns, newest last 6, contents clipped. Anything else (a "system"
// turn, non-strings, empties) is dropped. Returns undefined when nothing usable came in, so a
// legacy client gets exactly today's behaviour.
export function sanitizeHistory(history: unknown): HistoryTurn[] | undefined {
  if (!Array.isArray(history)) return undefined;
  const turns: HistoryTurn[] = [];
  for (const t of history.slice(-HISTORY_MAX_TURNS * 2)) {
    const role = (t as HistoryTurn | null)?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = cleanContent((t as HistoryTurn).content);
    if (content) turns.push({ role, content });
  }
  return turns.length ? turns.slice(-HISTORY_MAX_TURNS) : undefined;
}

// Accept the client's conversation ID only when it matches the safe pattern; else generate one.
export function sanitizeConversationId(v: unknown): string {
  return typeof v === "string" && CONVERSATION_ID_PATTERN.test(v) ? v : newConversationId();
}

// The prior USER questions only: what the answer prompt may see as context. Assistant answers
// are deliberately left out, so the model cannot restate content from before a revocation.
export const priorQuestions = (history: HistoryTurn[]): string[] =>
  history.filter((t) => t.role === "user").map((t) => t.content);
