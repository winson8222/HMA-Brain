// npm run seed:drive [-- <flag>]: builds the demo "Company A" folder in the admin's Drive from seedContent.ts
// and shares it with the personas. Writes only to Drive (the crawler picks it up). Safe to re-run: folders and
// files are found by name, and missing shares are added back (which also undoes --close-vendor-access).
//   --edit-runbook          S2: the runbook owner's update (pay-db-2 retired, promote pay-db-3, pool at least 400)
//   --close-vendor-access   S4: remove Dave's share on the postmortem
//   --reset                 between rehearsals: runbook back to the original, every share restored
//   --batch 2|4             the DB migration plan's status update that goes with the Slack batch of that number
//   --rewrite               rewrite every file from seedContent.ts (after editing the content)
import { Readable } from "node:stream";
import type { slides_v1 } from "googleapis";
import { accountEmail, drive, explain, findFolder, slides, withRetry } from "../client.js";
import { driveConfig } from "../config.js";
import { FOLDER, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, PDF } from "../extract.js";
import { personaEmail, type Persona } from "../people.js";
import { textPdf } from "./minipdf.js";
import {
  FILES,
  FOLDERS,
  MIGRATION_NAME,
  MIGRATION_STAGES,
  POSTMORTEM_NAME,
  RUNBOOK_NAME,
  migrationPlan,
  runbook,
  type Kind,
  type SeedFile,
  type Slide,
} from "./seedContent.js";

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findFile(name: string, parentId: string): Promise<string | null> {
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

// A seeded file by its path under the root folder, for the flags that change one file.
async function locate(folder: string[], name: string): Promise<string> {
  let parent = (await findFolder(driveConfig.rootFolderName, "root"))?.id;
  for (const part of folder) parent = parent ? (await findFolder(part, parent))?.id : undefined;
  const id = parent ? await findFile(name, parent) : null;
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

const fileNamed = (name: string) => FILES.find((f) => f.name === name)!;

// ---- the demo moments ----

const sgtNow = () =>
  `${new Date().toLocaleString("en-GB", { timeZone: "Asia/Singapore", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} SGT`;

async function setRunbook(edited: boolean) {
  const f = fileNamed(RUNBOOK_NAME);
  await writeContent(await locate(f.folder, f.name), f, runbook(edited ? sgtNow() : undefined));
  console.log(edited ? "Runbook updated: pay-db-2 retired, failover to pay-db-3, pool at least 400." : "Runbook back to the original (pay-db-2, pool 200).");
}

async function setMigrationStage(stage: number) {
  const f = fileNamed(MIGRATION_NAME);
  await writeContent(await locate(f.folder, f.name), f, migrationPlan(stage));
  console.log(`DB migration plan status set to batch ${stage}.`);
}

// S4: the postmortem was shared with Dave so Acme could confirm its part of the timeline; Carol takes it back.
async function closeVendorAccess() {
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

async function seed(admin: string, rewrite: boolean) {
  console.log(`Seeding "${driveConfig.rootFolderName}" in ${admin}'s Drive`);
  const rootId = await ensureFolder(driveConfig.rootFolderName, "root");
  const folderIds = new Map<string, string>([["", rootId]]);
  for (const f of FOLDERS) {
    const id = await ensureFolder(f.path.at(-1)!, folderIds.get(f.path.slice(0, -1).join("/"))!);
    folderIds.set(f.path.join("/"), id);
    await ensureShares(id, f.path.join("/"), f.readers, f.writers, admin);
  }
  for (const f of FILES) {
    const parent = folderIds.get(f.folder.join("/"))!;
    let id = await findFile(f.name, parent);
    if (!id) {
      id = await createFile(f, parent);
      console.log(`  created ${[...f.folder, f.name].join("/")} (${f.kind})`);
    } else if (rewrite) {
      await writeContent(id, f);
      console.log(`  rewrote ${[...f.folder, f.name].join("/")}`);
    }
    await ensureShares(id, f.name, f.readers, f.writers, admin);
  }
  console.log(`Done: ${FILES.length} files. Root folder ID: ${rootId}`);
}

async function main() {
  const has = (flag: string) => process.argv.includes(flag);
  if (has("--edit-runbook")) return setRunbook(true);
  if (has("--close-vendor-access")) return closeVendorAccess();
  const b = process.argv.indexOf("--batch");
  if (b >= 0) {
    const stage = Number(process.argv[b + 1]);
    if (!MIGRATION_STAGES.includes(stage)) throw new Error(`--batch needs one of: ${MIGRATION_STAGES.join(", ")}`);
    return setMigrationStage(stage);
  }
  await seed((await accountEmail())?.toLowerCase() ?? "", has("--rewrite"));
  if (has("--reset")) await setRunbook(false);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(explain(e));
    process.exit(1);
  });
