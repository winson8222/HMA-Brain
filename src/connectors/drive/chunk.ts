// Splits extracted text into search-sized chunks. Pure functions, unit-tested.
import type { TextFormat } from "./extract.js";

export type Chunk = { heading: string | null; text: string };

export const CHUNK_CHARS = 3000; // about 800 tokens
export const OVERLAP_CHARS = 450; // about 15%

export function chunkText(text: string, format: TextFormat, max = CHUNK_CHARS, overlap = OVERLAP_CHARS): Chunk[] {
  const t = text.trim();
  if (!t) return [];
  if (format === "csv") return chunkCsv(t, max);

  // Markdown: one block per heading section, packed together until a chunk is full.
  // Plain text: a single block.
  const blocks = format === "markdown" ? sections(t) : [{ heading: null, headingLine: "", body: t }];
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const b of blocks) {
    const whole = b.headingLine ? (b.body ? `${b.headingLine}\n${b.body}` : b.headingLine) : b.body;
    if (!whole) continue;
    if (whole.length > max) {
      // A section too big for one chunk: split its body, repeating the heading on every piece.
      if (cur) chunks.push(cur);
      cur = null;
      const room = Math.max(200, max - b.headingLine.length - 1);
      for (const piece of splitLong(b.body, room, overlap)) {
        chunks.push({ heading: b.heading, text: b.headingLine ? `${b.headingLine}\n${piece}` : piece });
      }
      continue;
    }
    if (cur && cur.text.length + 2 + whole.length > max) {
      chunks.push(cur);
      cur = null;
    }
    cur = cur ? { heading: cur.heading, text: `${cur.text}\n\n${whole}` } : { heading: b.heading, text: whole };
  }
  if (cur) chunks.push(cur);
  return chunks;
}

type Block = { heading: string | null; headingLine: string; body: string };

function sections(md: string): Block[] {
  const out: Block[] = [];
  let cur: Block = { heading: null, headingLine: "", body: "" };
  const lines: string[] = [];
  const close = () => {
    cur.body = lines.join("\n").trim();
    lines.length = 0;
    if (cur.headingLine || cur.body) out.push(cur);
  };
  for (const line of md.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      close();
      cur = { heading: h[1].trim(), headingLine: line.trim(), body: "" };
    } else lines.push(line);
  }
  close();
  return out;
}

// Pack paragraphs into pieces of at most `max` chars; each new piece starts with the tail of the previous one.
export function splitLong(body: string, max: number, overlap: number): string[] {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > max ? hardSplit(p, max, overlap) : [p]));
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + 2 + p.length > max) {
      out.push(cur);
      const t = tail(cur, overlap);
      cur = t && t.length + 2 + p.length <= max ? `${t}\n\n${p}` : p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

// Fixed windows over a single huge paragraph, broken at whitespace where possible.
function hardSplit(p: string, max: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < p.length) {
    let end = Math.min(p.length, start + max);
    if (end < p.length) {
      const ws = p.lastIndexOf(" ", end);
      if (ws > start + max / 2) end = ws;
    }
    out.push(p.slice(start, end).trim());
    if (end >= p.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  const ws = cut.search(/\s/);
  return (ws >= 0 ? cut.slice(ws) : cut).trim();
}

// Sheets: rows packed into chunks, each chunk repeating the header row.
function chunkCsv(csv: string, max: number): Chunk[] {
  const [header, ...rows] = csv.split("\n").filter((r) => r.trim());
  if (!rows.length) return [{ heading: null, text: header }];
  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let len = header.length;
  for (const r of rows) {
    if (cur.length && len + 1 + r.length > max) {
      chunks.push({ heading: null, text: [header, ...cur].join("\n") });
      cur = [];
      len = header.length;
    }
    cur.push(r);
    len += 1 + r.length;
  }
  if (cur.length) chunks.push({ heading: null, text: [header, ...cur].join("\n") });
  return chunks;
}
