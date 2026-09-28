// Google Drive API client for the crawler: runs as the admin account that connected Drive.
import { google, type drive_v3 } from "googleapis";
import { existsSync, readFileSync, statSync } from "node:fs";
import { newOAuthClient, saveToken } from "./auth.js";
import { driveConfig } from "./config.js";
import { FOLDER } from "./extract.js";

const auth = newOAuthClient();
let stored: Record<string, unknown> | null = null;
let account: string | null | undefined; // cached connected account, reset on reload
let loadedMtime = 0;

const tokenMtime = () => (existsSync(driveConfig.tokenFile) ? statSync(driveConfig.tokenFile).mtimeMs : 0);

// Load (or reload, after a new connect) the admin's token. False if Drive isn't connected yet;
// the server still starts, and every Drive call fails with NotConnectedError until it is.
export function loadToken(): boolean {
  account = undefined;
  loadedMtime = tokenMtime();
  if (!loadedMtime) {
    stored = null;
    return false;
  }
  stored = JSON.parse(readFileSync(driveConfig.tokenFile, "utf8"));
  auth.setCredentials(stored!);
  return true;
}
loadToken();

export const isConnected = () => {
  if (tokenMtime() !== loadedMtime) loadToken(); // connected or reconnected from another process
  return stored !== null;
};

// Google may hand out a new access token (and rarely a new refresh token); keep the file current,
// unless someone connected a different account in the meantime: then switch to that one instead.
auth.on("tokens", (t) => {
  if (tokenMtime() !== loadedMtime) return void loadToken();
  stored = { ...stored, ...t };
  saveToken(stored);
  loadedMtime = tokenMtime();
});

export class NotConnectedError extends Error {
  constructor() {
    super(`Google Drive isn't connected (no token at ${driveConfig.tokenFile}). Run \`npm run drive:connect\` and sign in as the admin account.`);
  }
}

export const drive: drive_v3.Drive = google.drive({ version: "v3", auth });

// ---- errors and retries ----

export const httpStatus = (e: any): number => Number(e?.response?.status ?? e?.status ?? e?.code) || 0;

export function isAuthError(e: any): boolean {
  if (e instanceof NotConnectedError) return true;
  const s = JSON.stringify(e?.response?.data ?? e?.message ?? "");
  return s.includes("invalid_grant") || s.includes("invalid_client");
}

export function explain(e: any): string {
  if (e instanceof NotConnectedError) return e.message;
  if (isAuthError(e)) return "Google token expired or was revoked. Run `npm run drive:connect` to reconnect.";
  return String(e?.response?.data?.error?.message ?? e?.message ?? e);
}

const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError", "internalError"]);

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  if (!isConnected()) throw new NotConnectedError();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = httpStatus(e);
      const reason = e?.response?.data?.error?.errors?.[0]?.reason ?? e?.errors?.[0]?.reason;
      const retryable = status === 429 || (status >= 500 && status < 600) || (status === 403 && RETRY_REASONS.has(reason));
      if (!retryable || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, Math.min(32_000, 1000 * 2 ** attempt) + Math.random() * 250));
    }
  }
}

// ---- calls ----

export const FILE_FIELDS =
  "id,name,mimeType,parents,trashed,md5Checksum,size,modifiedTime,webViewLink,owners(emailAddress)," +
  "permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted)";

// null when the file is gone or no longer visible to the crawler.
export async function getMeta(fileId: string): Promise<drive_v3.Schema$File | null> {
  try {
    return (await withRetry(() => drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true }))).data;
  } catch (e) {
    if (httpStatus(e) === 404) return null;
    throw e;
  }
}

export async function listChildren(folderId: string): Promise<drive_v3.Schema$File[]> {
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const r = await withRetry(() =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,parents)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    out.push(...(r.data.files ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function findFolder(name: string, parentId = "root"): Promise<drive_v3.Schema$File | null> {
  const q = `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType = '${FOLDER}' and '${parentId}' in parents and trashed = false`;
  const r = await withRetry(() => drive.files.list({ q, fields: "files(id,name)", pageSize: 10 }));
  const files = r.data.files ?? [];
  if (files.length > 1) console.warn(`warning: ${files.length} folders named "${name}"; using the first`);
  return files[0] ?? null;
}

export async function exportText(fileId: string, mimeType: string): Promise<string> {
  const r = await withRetry(() => drive.files.export({ fileId, mimeType }, { responseType: "text" }));
  return String(r.data ?? "");
}

export async function downloadBytes(fileId: string): Promise<Uint8Array> {
  const r = await withRetry(() => drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" }));
  return new Uint8Array(r.data as unknown as ArrayBuffer);
}

export async function downloadText(fileId: string): Promise<string> {
  const r = await withRetry(() => drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "text" }));
  return String(r.data ?? "");
}

export async function startPageToken(): Promise<string> {
  const r = await withRetry(() => drive.changes.getStartPageToken({ supportsAllDrives: true }));
  return r.data.startPageToken!;
}

export type ChangePage = { changes: drive_v3.Schema$Change[]; nextPageToken?: string; newStartPageToken?: string };

export async function listChanges(pageToken: string): Promise<ChangePage> {
  const r = await withRetry(() =>
    drive.changes.list({
      pageToken,
      pageSize: 1000,
      includeRemoved: true,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(mimeType))",
    }),
  );
  return {
    changes: r.data.changes ?? [],
    nextPageToken: r.data.nextPageToken ?? undefined,
    newStartPageToken: r.data.newStartPageToken ?? undefined,
  };
}

// The account the token belongs to, lowercased. Cached until the token is reloaded.
export async function accountEmail(): Promise<string | null> {
  if (account === undefined) {
    const r = await withRetry(() => drive.about.get({ fields: "user(emailAddress)" }));
    account = r.data.user?.emailAddress?.toLowerCase() ?? null;
  }
  return account;
}
