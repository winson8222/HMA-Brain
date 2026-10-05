// Folder map: is a file under the Company A root, and what's its path?
// Cached in memory, persisted in the state index, and filled from Drive for folders we haven't seen.
import { getMeta } from "./client.js";
import type { Location } from "./docs.js";
import { FOLDER } from "./extract.js";
import { allFolderStates, deleteFolderState, putFolderState } from "./store.js";

type Folder = { id: string; name: string; parentId: string | null };
const folders = new Map<string, Folder>();

export const cachedFolder = (id: string) => folders.get(id);

export async function rememberFolder(f: Folder, persist = true) {
  folders.set(f.id, f);
  if (persist) await putFolderState({ kind: "folder", folder_id: f.id, name: f.name, parent_id: f.parentId });
}

export async function forgetFolder(id: string) {
  folders.delete(id);
  await deleteFolderState(id);
}

export async function loadFolders() {
  for (const f of await allFolderStates()) folders.set(f.folder_id, { id: f.folder_id, name: f.name, parentId: f.parent_id });
}

// Walk up from `parentId` to the root. null if the chain never reaches the root (outside Company A).
// Folders fetched on the way are only remembered once the chain is proven to be under the root.
export async function locate(parentId: string | null | undefined, root: { id: string; name: string }): Promise<Location | null> {
  const chain: Folder[] = [];
  const fetched: Folder[] = [];
  let id = parentId ?? null;
  for (let depth = 0; id && depth < 64; depth++) {
    if (id === root.id) {
      for (const f of fetched) await rememberFolder(f);
      const down = [...chain].reverse(); // root's child → ... → parent
      return {
        path: [root.name, ...down.map((f) => f.name)].join(" / "),
        ancestorIds: [root.id, ...down.map((f) => f.id)],
      };
    }
    let f = folders.get(id);
    if (!f) {
      const meta = await getMeta(id);
      if (!meta || meta.trashed || meta.mimeType !== FOLDER) return null;
      f = { id, name: meta.name ?? id, parentId: meta.parents?.[0] ?? null };
      fetched.push(f);
    }
    chain.push(f);
    id = f.parentId;
  }
  return null;
}
