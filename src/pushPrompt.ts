import "dotenv/config";

// npm run prompts:seed — create the "ask-answer-rules" prompt in Langfuse from the
// in-code default (labelled production). Safe to re-run: Langfuse only creates a new
// version when the content changed.
import { ANSWER_RULES } from "./askRules.js";

const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
  throw new Error("Langfuse not configured: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env");

const res = await fetch(`${base}/api/public/prompts`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64"),
  },
  body: JSON.stringify({ name: "ask-answer-rules", prompt: ANSWER_RULES, labels: ["production"], isActive: true }),
});
if (!res.ok) throw new Error(`Seeding prompt failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
const data: any = await res.json();
console.log(`Prompt "ask-answer-rules" seeded as version ${data.version} (labels: ${data.labels?.join(", ")})`);
