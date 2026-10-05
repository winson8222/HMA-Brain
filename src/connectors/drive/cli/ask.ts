// npm run drive:ask -- --as bob "How do we fail over the payment database?"
// npm run drive:ask -- --as dave --search SLA
// Runs exactly what the Drive page runs, as that person, and writes the same audit record.
// You're the operator here, so it also prints the admin view: what was withheld and why.
import { formatRecord } from "../../../audit/format.js";
import { accountEmail, explain } from "../client.js";
import { demoPeople, findPerson } from "../people.js";
import { driveAsk, driveSearch } from "../query.js";

// Snippets are HTML (escaped, with <mark>); show them as text with *highlights*.
const plain = (html: string) =>
  html
    .replace(/<\/?mark>/g, "*")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const args = process.argv.slice(2);
const asIdx = args.indexOf("--as");
const who = asIdx >= 0 ? args[asIdx + 1] : undefined;
const searchOnly = args.includes("--search");
const question = args.filter((a, i) => a !== "--search" && i !== asIdx && i !== asIdx + 1).join(" ").trim();

try {
  const people = demoPeople(await accountEmail());
  const person = who ? findPerson(who, people) : null;
  if (!person || !question) {
    console.error(`Usage: npm run drive:ask -- --as <${people.map((p) => p.name.toLowerCase().split(" ")[0]).join("|")}> [--search] "question"`);
    process.exit(1);
  }
  console.log(`${searchOnly ? "Searching" : "Asking"} as ${person.name} (${person.email})\n`);

  if (searchOnly) {
    const { results, record } = await driveSearch(person.email, question, "cli");
    if (!results.length) console.log("No results found");
    for (const r of results) console.log(`- ${r.title}  (${r.path})\n  ${plain(r.snippet)}\n  ${r.permalink}`);
    console.log(`\n--- admin view (audit record) ---\n${formatRecord(record)}`);
  } else {
    const { answer, record } = await driveAsk(person.email, question, "cli");
    console.log(answer.answer);
    for (const s of answer.sources) {
      console.log(`  [${s.n}] ${s.title}  (${s.path}${s.heading && s.heading !== s.title ? ` › ${s.heading}` : ""})  ${s.permalink}`);
    }
    console.log(`\n--- admin view (audit record) ---\n${formatRecord(record)}`);
  }
  process.exit(0);
} catch (e) {
  console.error(explain(e));
  process.exit(1);
}
