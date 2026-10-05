import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aclHash, DRIVE_ANYONE, permsToAcl } from "../connectors/drive/acl.js";
import { chunkText } from "../connectors/drive/chunk.js";
import { contentHash, contentSignal, fileToDocs, mustFetchContent, planUpdate, stillEditing, type FileState } from "../connectors/drive/docs.js";
import { cleanMarkdown, extractionFor, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, TITLE_ONLY } from "../connectors/drive/extract.js";

// Permission and export payloads captured from the real Drive API in the Phase 0 spike.
const fx = (name: string) => readFileSync(`fixtures/drive/${name}`, "utf8");
const json = (name: string) => JSON.parse(fx(name));

describe("permsToAcl", () => {
  it("inherited folder access and owner become user labels; undiscoverable link gets none", () => {
    expect(permsToAcl(json("permissions_inherited_and_link.json"))).toEqual([
      "drive:user:alicehmatest@gmail.com",
      "drive:user:jithin.bathula@gmail.com",
    ]);
  });
  it("maps every permission type, lowercases emails, skips deleted and undiscoverable", () => {
    expect(permsToAcl(json("permissions_mixed.json"))).toEqual([
      DRIVE_ANYONE,
      "drive:domain:companya.com",
      "drive:group:eng-team@companya.com",
      "drive:user:alicehmatest@gmail.com",
      "drive:user:bob.hmatest@gmail.com",
    ]);
  });
  it("no permissions → no labels (nobody can see it)", () => expect(permsToAcl(undefined)).toEqual([]));
  it("hash ignores permission order", () => {
    const perms = json("permissions_mixed.json");
    expect(aclHash(permsToAcl(perms))).toBe(aclHash(permsToAcl([...perms].reverse())));
  });
});

describe("extraction", () => {
  it("Google Docs export as Markdown, Sheets as CSV, Slides as text", () => {
    expect(extractionFor(GOOGLE_DOC)).toEqual({ kind: "export", exportMime: "text/markdown", format: "markdown" });
    expect(extractionFor(GOOGLE_SHEET)).toMatchObject({ kind: "export", exportMime: "text/csv" });
    expect(extractionFor(GOOGLE_SLIDES)).toMatchObject({ kind: "export", exportMime: "text/plain" });
  });
  it("text files and PDFs are downloaded (PDFs parsed); images are title-only; folders skipped", () => {
    expect(extractionFor("text/markdown")).toEqual({ kind: "download", format: "markdown" });
    expect(extractionFor("application/pdf")).toEqual({ kind: "download", format: "plain", parser: "pdf" });
    expect(extractionFor("image/png")).toEqual({ kind: "title" });
    expect(extractionFor("application/vnd.google-apps.folder")).toEqual({ kind: "skip" });
  });
  it("cleans Drive's Markdown export (bold headings, quoted list items)", () => {
    expect(cleanMarkdown(fx("export_runbook.md"))).toBe(
      "# Payment service runbook\n\nOwner: Alice.\n\n## Failover\n\n1. Drain traffic from the primary.\n2. Promote the replica.\n3. Switch DNS to the secondary region.",
    );
  });
  it("removes Drive's backslash escapes", () => {
    expect(cleanMarkdown("Escalation: \\#payments\\-incident, replica pay\\-db\\-2 \\(primary\\)")).toBe(
      "Escalation: #payments-incident, replica pay-db-2 (primary)",
    );
  });
});

describe("chunkText", () => {
  const md = cleanMarkdown(fx("export_runbook.md"));
  it("small document → one chunk keeping its headings", () => {
    const c = chunkText(md, "markdown");
    expect(c).toHaveLength(1);
    expect(c[0].heading).toBe("Payment service runbook");
    expect(c[0].text).toContain("## Failover");
  });
  it("splits at section boundaries when full", () => {
    const doc = ["# A", "a".repeat(80), "## B", "b".repeat(80), "## C", "c".repeat(80)].join("\n");
    const c = chunkText(doc, "markdown", 120, 20);
    expect(c.map((x) => x.heading)).toEqual(["A", "B", "C"]);
    for (const x of c) expect(x.text.length).toBeLessThanOrEqual(120);
  });
  it("a long section is split with overlap and the heading repeated", () => {
    const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(10)}`).join("\n\n");
    const c = chunkText(`## Steps\n${body}`, "markdown", 300, 60);
    expect(c.length).toBeGreaterThan(3);
    for (const x of c) {
      expect(x.text.startsWith("## Steps\n")).toBe(true);
      expect(x.text.length).toBeLessThanOrEqual(300);
    }
    // overlap: the start of each chunk (after the heading) repeats text from the end of the previous one
    const firstBody = c[0].text.slice("## Steps\n".length);
    const secondBody = c[1].text.slice("## Steps\n".length);
    expect(firstBody.includes(secondBody.slice(0, 20))).toBe(true);
  });
  it("CSV chunks repeat the header row", () => {
    const csv = ["Week,Primary", ...Array.from({ length: 40 }, (_, i) => `W${i},Person${i}`)].join("\n");
    const c = chunkText(csv, "csv", 100);
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) expect(x.text.startsWith("Week,Primary\n")).toBe(true);
  });
  it("empty text → no chunks", () => expect(chunkText("  \n ", "plain")).toEqual([]));
});

describe("fileToDocs", () => {
  const file = { id: "F1", name: "Payment service runbook", mimeType: GOOGLE_DOC, modifiedTime: "2026-09-27T10:00:00.000Z", webViewLink: "https://docs.google.com/document/d/F1/edit", owners: [{ emailAddress: "Alice@x.com" }] };
  const loc = { path: "Company A / Engineering / Runbooks", ancestorIds: ["ROOT", "ENG", "RUN"] };
  const acl = ["drive:user:alice@x.com", "drive:user:bob@x.com"];

  it("chunks carry the label, title, path, link and a stable id", () => {
    const docs = fileToDocs(file, { text: cleanMarkdown(fx("export_runbook.md")), format: "markdown", titleOnly: false }, acl, loc);
    expect(docs[0]).toMatchObject({
      doc_id: "drive:F1:0",
      source: "drive",
      file_id: "F1",
      title: "Payment service runbook",
      path: loc.path,
      ancestor_ids: loc.ancestorIds,
      acl_container: acl,
      owner_email: "alice@x.com",
      permalink: file.webViewLink,
      title_only: false,
    });
    expect(docs[0].text.startsWith("Payment service runbook (Company A / Engineering / Runbooks)\n\n# Payment")).toBe(true);
  });
  it("title-only files still get one searchable doc", () => {
    const docs = fileToDocs({ ...file, mimeType: "application/pdf" }, TITLE_ONLY, acl, loc);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title_only: true, text: "Payment service runbook (Company A / Engineering / Runbooks)" });
  });
});

describe("change handling", () => {
  const prev: FileState = {
    kind: "file",
    file_id: "F1",
    name: "Runbook",
    mime_type: GOOGLE_DOC,
    path: "Company A / Eng",
    ancestor_ids: ["ROOT", "ENG"],
    content_signal: null,
    content_hash: "h1",
    acl_hash: "a1",
    chunk_count: 1,
    status: "indexed",
    error: null,
    modified_at: null,
    indexed_at: "2026-09-27T10:00:00.000Z",
  };
  const same = { name: "Runbook", path: "Company A / Eng", aclHash: "a1", contentHash: "h1" };

  it("new file → reindex", () => expect(planUpdate(undefined, same)).toBe("reindex"));
  it("nothing changed → none", () => expect(planUpdate(prev, same)).toBe("none"));
  it("content changed → reindex", () => expect(planUpdate(prev, { ...same, contentHash: "h2" })).toBe("reindex"));
  it("only sharing changed → relabel (no re-download)", () => expect(planUpdate(prev, { ...same, aclHash: "a2" })).toBe("relabel"));
  it("renamed or moved → reindex (chunks carry title and path)", () => {
    expect(planUpdate(prev, { ...same, name: "Runbook v2" })).toBe("reindex");
    expect(planUpdate(prev, { ...same, path: "Company A / Other" })).toBe("reindex");
  });
  it("previous attempt failed → retry", () => expect(planUpdate({ ...prev, status: "error" }, same)).toBe("reindex"));
  it("content unknown (not fetched) and sharing same → none", () => expect(planUpdate(prev, { ...same, contentHash: null })).toBe("none"));

  it("Google-native files have no content signal and are always exported", () => {
    expect(contentSignal({ mimeType: GOOGLE_DOC, modifiedTime: "t" })).toBeNull();
    expect(mustFetchContent(prev, "export", null, "Runbook", "Company A / Eng")).toBe(true);
  });
  it("stored files are only downloaded when their md5 (or name/path) changed", () => {
    const stored = { ...prev, mime_type: "text/markdown", content_signal: "md5-a" };
    expect(contentSignal({ mimeType: "text/markdown", md5Checksum: "md5-a" })).toBe("md5-a");
    expect(mustFetchContent(stored, "download", "md5-a", "Runbook", "Company A / Eng")).toBe(false);
    expect(mustFetchContent(stored, "download", "md5-b", "Runbook", "Company A / Eng")).toBe(true);
    expect(mustFetchContent(stored, "download", "md5-a", "Renamed", "Company A / Eng")).toBe(true);
    expect(mustFetchContent(undefined, "download", "md5-a", "Runbook", "Company A / Eng")).toBe(true);
  });
  it("title-only files are never fetched", () => expect(mustFetchContent(undefined, "title", "x", "a", "b")).toBe(false));
  it("chunks written without vectors are retried when embeddings are on", () => {
    const noVec = { ...prev, vectors: false };
    expect(planUpdate(noVec, { ...same, wantVectors: true })).toBe("reindex");
    expect(planUpdate(noVec, { ...same, wantVectors: false })).toBe("none");
    expect(planUpdate({ ...prev, vectors: true }, { ...same, wantVectors: true })).toBe("none");
    expect(planUpdate(prev, { ...same, wantVectors: true })).toBe("none"); // older state without the flag: assume fine
    const stored = { ...noVec, mime_type: "text/markdown", content_signal: "md5-a" };
    expect(mustFetchContent(stored, "download", "md5-a", "Runbook", "Company A / Eng", true)).toBe(true);
  });
  it("content hash depends on text and format", () => {
    expect(contentHash({ text: "a", format: "plain", titleOnly: false })).not.toBe(contentHash({ text: "b", format: "plain", titleOnly: false }));
    expect(contentHash(TITLE_ONLY)).not.toBe(contentHash({ text: "", format: "plain", titleOnly: false }));
  });
});

describe("debounce (stillEditing)", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  it("a file edited within the quiet window is still being edited", () => {
    expect(stillEditing("2026-10-01T11:59:30Z", now, 120_000)).toBe(true);
  });
  it("a file quiet for longer than the window is ready", () => {
    expect(stillEditing("2026-10-01T11:57:00Z", now, 120_000)).toBe(false);
  });
  it("off when the window is 0, or the time is unknown or invalid", () => {
    expect(stillEditing("2026-10-01T11:59:59Z", now, 0)).toBe(false);
    expect(stillEditing(null, now, 120_000)).toBe(false);
    expect(stillEditing("not a date", now, 120_000)).toBe(false);
  });
});
