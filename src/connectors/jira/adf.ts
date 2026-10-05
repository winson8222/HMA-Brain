// Atlassian Document Format (Jira Cloud's rich text for descriptions and comments) → plain text.
// Pure, unit-tested. Unknown node types keep their text, so new formatting never loses content.
type Node = { type?: string; text?: string; attrs?: Record<string, any>; content?: Node[] };

const BLOCKS = new Set(["paragraph", "heading", "blockquote", "codeBlock", "panel", "rule", "tableRow", "mediaGroup", "mediaSingle"]);

function walk(n: Node, out: string[], prefix = "") {
  switch (n.type) {
    case "text":
      out.push(n.text ?? "");
      return;
    case "hardBreak":
      out.push("\n");
      return;
    case "mention":
      out.push(String(n.attrs?.text ?? "@someone"));
      return;
    case "emoji":
      out.push(String(n.attrs?.text ?? n.attrs?.shortName ?? ""));
      return;
    case "inlineCard":
    case "blockCard":
      out.push(String(n.attrs?.url ?? ""));
      return;
    case "status":
      out.push(`[${n.attrs?.text ?? ""}]`);
      return;
    case "date":
      out.push(n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "");
      return;
    case "listItem":
      out.push(prefix);
      for (const c of n.content ?? []) walk(c, out);
      out.push("\n");
      return;
    case "bulletList":
    case "orderedList":
      (n.content ?? []).forEach((c, i) => walk(c, out, n.type === "orderedList" ? `${i + 1}. ` : "- "));
      return;
    case "tableCell":
    case "tableHeader":
      for (const c of n.content ?? []) walk(c, out);
      out.push(" | ");
      return;
  }
  for (const c of n.content ?? []) walk(c, out, prefix);
  if (n.type && BLOCKS.has(n.type)) out.push("\n");
}

export function adfToText(doc: unknown): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc.trim(); // Jira Server / API v2 style plain text
  const out: string[] = [];
  walk(doc as Node, out);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
