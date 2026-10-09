// Confluence page → Elasticsearch chunk docs. Pure functions, unit-tested.
import { adfToText } from "../jira/adf.js";
import { sha256 } from "./acl.js";
import type { RawPage } from "./client.js";

// One space's permission picture (see spaces.ts). Its pages are labelled from it.
export type SpaceAcl = {
  space_id: string;
  key: string;
  name: string;
  view: string[]; // who may view the space
  hash: string; // changes whenever `view` changes: the space's pages must be relabelled
};

export type ConfluenceDoc = {
  doc_id: string; // confluence:<site>:<pageId>:<chunk>
  source: "confluence";
  page_id: string;
  space_id: string;
  space_key: string;
  space_name: string;
  parent_id: string | null;
  chunk_index: number;
  title: string;
  text: string;
  author_id: string | null; // last modifier
  author_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  version: number | null;
  ts: string;
  permalink: string;
  acl_container: string[]; // space View, see acl.ts
  restricted: boolean; // this page or an ancestor has a view restriction
  acl_item: string[]; // the nearest restriction's members; empty when not restricted
  content_hash: string; // covers the text AND the labels: a permission change rewrites the page too
};

export const CHUNK_CHARS = 3000; // about 800 tokens, like Drive and Jira
const MAX_CHUNKS = 20;

export const confluenceDocId = (site: string, pageId: string, n: number) => `confluence:${site}:${pageId}:${n}`;

// The body as plain text. atlas_doc_format carries the ADF document as a JSON string.
export function pageText(page: RawPage): string {
  const raw = page.body?.atlas_doc_format?.value;
  if (!raw) return "";
  try {
    return adfToText(JSON.parse(raw));
  } catch {
    return "";
  }
}

// Paragraph-aware chunks: paragraphs are packed up to CHUNK_CHARS; an oversized paragraph is cut.
export function pageChunks(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    for (let i = 0; i < Math.max(1, para.length); i += CHUNK_CHARS) {
      const piece = para.slice(i, i + CHUNK_CHARS);
      if (!piece) continue;
      if (cur && cur.length + 2 + piece.length > CHUNK_CHARS) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return (out.length ? out : [""]).slice(0, MAX_CHUNKS);
}

export function pageToDocs(
  site: string,
  baseUrl: string,
  page: RawPage,
  space: SpaceAcl,
  effective: string[] | null, // nearest view restriction's labels, null when unrestricted
  authorName: string | null,
): ConfluenceDoc[] {
  const title = page.title ?? "";
  const chunks = pageChunks(pageText(page));
  const restricted = effective !== null;
  const acl_item = effective ?? [];
  const updated = page.version?.createdAt ?? page.createdAt ?? null;
  const base = {
    source: "confluence" as const,
    page_id: page.id,
    space_id: space.space_id,
    space_key: space.key,
    space_name: space.name,
    parent_id: page.parentType === "page" && page.parentId ? page.parentId : null,
    title,
    author_id: page.version?.authorId ?? page.authorId ?? null,
    author_name: authorName,
    created_at: page.createdAt ?? null,
    updated_at: updated,
    version: page.version?.number ?? null,
    ts: updated ?? new Date().toISOString(),
    permalink: page._links?.webui ? `${baseUrl}/wiki${page._links.webui}` : `${baseUrl}/wiki/pages/viewpage.action?pageId=${page.id}`,
    acl_container: space.view,
    restricted,
    acl_item,
    content_hash: sha256(JSON.stringify([title, chunks, space.view, restricted, acl_item])),
  };
  return chunks.map((c, i) => ({ ...base, doc_id: confluenceDocId(site, page.id, i), chunk_index: i, text: c ? `${title}\n\n${c}` : title }));
}
