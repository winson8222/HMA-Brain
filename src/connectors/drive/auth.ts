// OAuth helpers with no side effects, so `drive:connect` can run before a token exists.
import { google } from "googleapis";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnv } from "../../config.js";
import { driveConfig } from "./config.js";

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly", // crawler: read everything the admin can see
  "https://www.googleapis.com/auth/drive.file", // seed script only: create and share its own demo files
];

export function newOAuthClient(redirectUri?: string) {
  return new google.auth.OAuth2(requireEnv("GOOGLE_CLIENT_ID"), requireEnv("GOOGLE_CLIENT_SECRET"), redirectUri);
}

export function saveToken(tokens: object) {
  mkdirSync(dirname(driveConfig.tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(driveConfig.tokenFile, JSON.stringify(tokens), { mode: 0o600 });
}
