// npm run drive:connect — one time: sign in as the Company A admin and approve read access.
// Saves the refresh token to GOOGLE_TOKEN_FILE; the crawler runs on it from then on.
import { google } from "googleapis";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { newOAuthClient, saveToken, SCOPES } from "../auth.js";
import { driveConfig } from "../config.js";

const PORT = 8765; // must match an Authorized redirect URI on the Google OAuth client
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const oauth = newOAuthClient(REDIRECT);
const state = randomBytes(16).toString("hex");
// prompt=consent makes Google return a refresh token even if this account approved the app before.
const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });

const code = await new Promise<string>((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", REDIRECT);
    if (u.pathname !== "/oauth2callback") return void res.writeHead(404).end();
    const err = u.searchParams.get("error");
    if (err || u.searchParams.get("state") !== state) {
      res.end("Sign-in failed. Check the terminal.");
      server.close();
      return reject(new Error(err ?? "OAuth state mismatch"));
    }
    res.end("Google Drive connected. You can close this tab.");
    server.close();
    resolve(u.searchParams.get("code")!);
  });
  server.listen(PORT, () => {
    console.log(`Sign in as the Company A ADMIN account:\n\n${url}\n`);
    spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
  });
});

const { tokens } = await oauth.getToken(code);
if (!tokens.refresh_token) {
  console.error("Google didn't return a refresh token. Remove HMA Brain at https://myaccount.google.com/permissions and run this again.");
  process.exit(1);
}
saveToken(tokens);
oauth.setCredentials(tokens);
const who = await google.drive({ version: "v3", auth: oauth }).about.get({ fields: "user(emailAddress)" });
console.log(`Connected as ${who.data.user?.emailAddress}. Token saved to ${driveConfig.tokenFile}.`);
process.exit(0);
