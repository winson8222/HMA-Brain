// Which files we can read as text, and how. Pure functions, unit-tested.
// Fetching happens in sync.ts.

export const FOLDER = "application/vnd.google-apps.folder";
export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const SHORTCUT = "application/vnd.google-apps.shortcut";
export const PDF = "application/pdf";

export type TextFormat = "markdown" | "csv" | "plain";

export type Extraction =
  | { kind: "export"; exportMime: string; format: TextFormat } // Google Docs/Sheets/Slides
  | { kind: "download"; format: TextFormat; parser?: "pdf" } // files stored in Drive: text as is, PDFs parsed
  | { kind: "title" } // anything else (images, Office files, ...): index the title only for now
  | { kind: "skip" }; // folders, shortcuts

export type Extracted = { text: string; format: TextFormat; titleOnly: boolean; note?: string };

const DOWNLOADABLE: Record<string, TextFormat> = {
  "text/plain": "plain",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/csv": "csv",
  "application/json": "plain",
};

export function extractionFor(mimeType: string): Extraction {
  switch (mimeType) {
    case FOLDER:
    case SHORTCUT:
      return { kind: "skip" };
    case GOOGLE_DOC:
      return { kind: "export", exportMime: "text/markdown", format: "markdown" };
    case GOOGLE_SHEET:
      return { kind: "export", exportMime: "text/csv", format: "csv" }; // first sheet only
    case GOOGLE_SLIDES:
      return { kind: "export", exportMime: "text/plain", format: "plain" };
  }
  if (mimeType === PDF) return { kind: "download", format: "plain", parser: "pdf" };
  const format = DOWNLOADABLE[mimeType];
  return format ? { kind: "download", format } : { kind: "title" };
}

// Google-native files have no md5, so their content can only be compared after exporting.
export const isGoogleNative = (mimeType: string) => mimeType.startsWith("application/vnd.google-apps.");

export const TITLE_ONLY: Extracted = { text: "", format: "plain", titleOnly: true };

// Drive's Markdown export wraps headings in bold (`# **Title**`), list items in quotes (`> 1. ...`)
// and backslash-escapes punctuation in text (`\#payments-incident`, `pay\-db\-2`).
export function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const l = line
        .replace(/^> ?/, "")
        .replace(/\s+$/, "")
        .replace(/\\([\\`*_{}\[\]()#+\-.!|<>~=])/g, "$1");
      const h = l.match(/^(#{1,6})\s+\*\*(.+?)\*\*$/);
      return h ? `${h[1]} ${h[2]}` : l;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalise(text: string, format: TextFormat): string {
  return format === "markdown" ? cleanMarkdown(text) : text.replace(/\r\n?/g, "\n").trim();
}
