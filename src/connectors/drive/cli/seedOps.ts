// The Drive writes behind seed:drive and seed:story: folders, files, shares and the demo moments.
// Everything is found by name under the root folder, so each step is safe to repeat.
import { Readable } from "node:stream";
import type { slides_v1 } from "googleapis";
import { drive, findFolder, slides, withRetry } from "../client.js";
import { driveConfig } from "../config.js";
import { FOLDER, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, PDF } from "../extract.js";
import { personaEmail, type Persona } from "../people.js";
import { textPdf } from "./minipdf.js";
import {
  FILES,
  FOLDERS,
  MIGRATION_NAME,
  POSTMORTEM_NAME,
  RUNBOOK_NAME,
  migrationPlan,
  runbook,
  storyDayToday,
  type Kind,
  type RunbookVersion,
  type SeedFile,
  type Slide,
} from "./seedContent.js";

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function findFile(name: string, parentId: string): Promise<string | null> {
  const r = await withRetry(() =>
    drive.files.list({ q: `name = '${q(name)}' and '${parentId}' in parents and mimeType != '${FOLDER}' and trashed = false`, fields: "files(id)" }),
  );
  return r.data.files?.[0]?.id ?? null;
}

async function ensureFolder(name: string, parentId: string): Promise<string> {
  const found = await findFolder(name, parentId);
  if (found) return found.id!;
  const r = await withRetry(() => drive.files.create({ requestBody: { name, mimeType: FOLDER, parents: [parentId] }, fields: "id" }));
  console.log(`  created folder ${name}`);
  return r.data.id!;
}

async function folderId(folder: string[]): Promise<string | undefined> {
  let parent = (await findFolder(driveConfig.rootFolderName, "root"))?.id ?? undefined;
  for (const part of folder) parent = parent ? ((await findFolder(part, parent))?.id ?? undefined) : undefined;
  return parent;
}

// A seeded file by its path under the root folder, or null if it isn't there.
async function find(folder: string[], name: string): Promise<string | null> {
  const parent = await folderId(folder);
  return parent ? findFile(name, parent) : null;
}

export async function locate(folder: string[], name: string): Promise<string> {
  const id = await find(folder, name);
  if (!id) throw new Error(`No ${[driveConfig.rootFolderName, ...folder, name].join("/")}. Run \`npm run seed:drive\` first.`);
  return id;
}

// ---- sharing ----

type Role = "reader" | "writer";
const warned = new Set<Persona>();

async function ensureShares(fileId: string, label: string, readers: Persona[] = [], writers: Persona[] = [], admin: string) {
  const want: [Persona, Role][] = [...readers.map((p): [Persona, Role] => [p, "reader"]), ...writers.map((p): [Persona, Role] => [p, "writer"])];
  if (!want.length) return;
  const r = await withRetry(() => drive.permissions.list({ fileId, fields: "permissions(id,emailAddress,role)" }));
  for (const [p, role] of want) {
    const email = personaEmail(p);
    if (!email) {
      if (!warned.has(p)) console.warn(`  ${p.toUpperCase()}_EMAIL is not set in .env: not sharing anything with ${p}`);
      warned.add(p);
      continue;
    }
    if (email === admin) continue; // the admin owns every file
    const have = r.data.permissions?.find((x) => x.emailAddress?.toLowerCase() === email);
    if (have?.role === role || have?.role === "owner") continue;
    try {
      if (have) await withRetry(() => drive.permissions.update({ fileId, permissionId: have.id!, requestBody: { role } }));
      else
        await withRetry(() =>
          drive.permissions.create({ fileId, sendNotificationEmail: false, requestBody: { type: "user", role, emailAddress: email } }),
        );
      console.log(`  shared ${label} with ${p} (${role})`);
    } catch (e: any) {
      console.warn(`  couldn't share ${label} with ${p} (${email}): ${e?.message ?? e}`);
    }
  }
}

// ---- content ----

// Media we upload, and the type Drive stores it as (a Google type means "convert on upload").
const UPLOAD: Record<Exclude<Kind, "slides">, [media: string, stored: string]> = {
  doc: ["text/html", GOOGLE_DOC],
  sheet: ["text/csv", GOOGLE_SHEET],
  markdown: ["text/markdown", "text/markdown"],
  text: ["text/plain", "text/plain"],
  csv: ["text/csv", "text/csv"],
  json: ["application/json", "application/json"],
  pdf: [PDF, PDF],
};

const media = (kind: Exclude<Kind, "slides">, body: string) => ({
  mimeType: UPLOAD[kind][0],
  body: kind === "pdf" ? Readable.from([textPdf(body)]) : body,
});

// Replaces every slide: a title slide, then a title-and-body slide per entry. New slides go in first, so the
// deck is never empty.
async function writeSlides(presentationId: string, deck: Slide[]) {
  const old = await withRetry(() => slides.presentations.get({ presentationId, fields: "slides.objectId" }));
  const run = Date.now().toString(36);
  const requests: slides_v1.Schema$Request[] = deck.flatMap((s, i) => {
    const id = `s${run}_${i}`;
    const [title, body] = i === 0 ? ["CENTERED_TITLE", "SUBTITLE"] : ["TITLE", "BODY"];
    return [
      {
        createSlide: {
          objectId: id,
          slideLayoutReference: { predefinedLayout: i === 0 ? "TITLE" : "TITLE_AND_BODY" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: title, index: 0 }, objectId: `${id}_t` },
            { layoutPlaceholder: { type: body, index: 0 }, objectId: `${id}_b` },
          ],
        },
      },
      { insertText: { objectId: `${id}_t`, text: s.title } },
      { insertText: { objectId: `${id}_b`, text: s.body } },
    ];
  });
  for (const s of old.data.slides ?? []) requests.push({ deleteObject: { objectId: s.objectId! } });
  await withRetry(() => slides.presentations.batchUpdate({ presentationId, requestBody: { requests } }));
}

async function createFile(f: SeedFile, parent: string): Promise<string> {
  if (f.kind === "slides") {
    const r = await withRetry(() => drive.files.create({ requestBody: { name: f.name, mimeType: GOOGLE_SLIDES, parents: [parent] }, fields: "id" }));
    await writeSlides(r.data.id!, f.body as Slide[]);
    return r.data.id!;
  }
  const kind = f.kind;
  const r = await withRetry(() =>
    drive.files.create({
      requestBody: { name: f.name, mimeType: UPLOAD[kind][1], parents: [parent] },
      media: media(kind, f.body as string),
      fields: "id",
    }),
  );
  return r.data.id!;
}

async function writeContent(fileId: string, f: SeedFile, body: string | Slide[] = f.body) {
  if (f.kind === "slides") return writeSlides(fileId, body as Slide[]);
  const kind = f.kind;
  await withRetry(() => drive.files.update({ fileId, media: media(kind, body as string) }));
}

export const fileNamed = (name: string) => {
  const f = FILES.find((x) => x.name === name);
  if (!f) throw new Error(`No seed file named ${name}`);
  return f;
};

// ---- single-file steps (seed:story and the demo flags) ----

// Writes one file's content (default: its latest version from seedContent.ts).
export async function rewrite(name: string, body?: string | Slide[]) {
  const f = fileNamed(name);
  await writeContent(await locate(f.folder, f.name), f, body ?? f.body);
}

// Creates one file (with its shares) if it's missing.
export async function createNamed(name: string, admin: string) {
  const f = fileNamed(name);
  const parent = await folderId(f.folder);
  if (!parent) throw new Error(`No folder ${f.folder.join("/")}. Run \`npm run seed:drive\` first.`);
  let id = await findFile(f.name, parent);
  if (!id) {
    id = await createFile(f, parent);
    console.log(`  created ${[...f.folder, f.name].join("/")} (${f.kind})`);
  }
  await ensureShares(id, f.name, f.readers, f.writers, admin);
}

// Moves a file to the trash (recoverable for 30 days). Returns false if it wasn't there.
export async function trash(folder: string[], name: string): Promise<boolean> {
  const id = await find(folder, name);
  if (!id) return false;
  await withRetry(() => drive.files.update({ fileId: id, requestBody: { trashed: true } }));
  console.log(`  trashed ${[...folder, name].join("/")}`);
  return true;
}

// ---- the demo moments ----

export const sgtNow = () =>
  `${new Date().toLocaleString("en-GB", { timeZone: "Asia/Singapore", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} SGT`;

export async function setRunbook(version: RunbookVersion) {
  await rewrite(RUNBOOK_NAME, runbook(version));
}

export async function setMigrationStage(stage: number) {
  await rewrite(MIGRATION_NAME, migrationPlan(stage));
}

// S4: the postmortem was shared with Dave so Acme could confirm its part of the timeline; Carol takes it back.
export async function closeVendorAccess() {
  const email = personaEmail("dave");
  if (!email) throw new Error("DAVE_EMAIL is not set in .env");
  const f = fileNamed(POSTMORTEM_NAME);
  const fileId = await locate(f.folder, f.name);
  const r = await withRetry(() => drive.permissions.list({ fileId, fields: "permissions(id,emailAddress)" }));
  const perm = r.data.permissions?.find((p) => p.emailAddress?.toLowerCase() === email);
  if (!perm) return console.log("Dave has no share on the postmortem; nothing to remove.");
  await withRetry(() => drive.permissions.delete({ fileId, permissionId: perm.id! }));
  console.log("Removed Dave from the postmortem. His next question is already filtered (live re-check); the index catches up on the next poll.");
  console.log("Run `npm run seed:drive` to share it with him again.");
}

// ---- the whole folder ----

// Files that belong to a later story day are left out until that day (seed:story creates them).
export async function seed(admin: string, rewriteAll: boolean) {
  console.log(`Seeding "${driveConfig.rootFolderName}" in ${admin}'s Drive`);
  const rootId = await ensureFolder(driveConfig.rootFolderName, "root");
  const folderIds = new Map<string, string>([["", rootId]]);
  for (const f of FOLDERS) {
    const id = await ensureFolder(f.path.at(-1)!, folderIds.get(f.path.slice(0, -1).join("/"))!);
    folderIds.set(f.path.join("/"), id);
    await ensureShares(id, f.path.join("/"), f.readers, f.writers, admin);
  }
  const today = storyDayToday();
  let n = 0;
  for (const f of FILES) {
    const parent = folderIds.get(f.folder.join("/"))!;
    let id = await findFile(f.name, parent);
    if (!id) {
      if ((f.day ?? 0) > today) {
        console.log(`  skipped ${[...f.folder, f.name].join("/")}: it appears on story day ${f.day} (npm run seed:story)`);
        continue;
      }
      id = await createFile(f, parent);
      console.log(`  created ${[...f.folder, f.name].join("/")} (${f.kind})`);
    } else if (rewriteAll) {
      await writeContent(id, f);
      console.log(`  rewrote ${[...f.folder, f.name].join("/")}`);
    }
    await ensureShares(id, f.name, f.readers, f.writers, admin);
    n++;
  }
  console.log(`Done: ${n} files. Root folder ID: ${rootId}`);
}
