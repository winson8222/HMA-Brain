import "../../config.js"; // loads .env

export const driveConfig = {
  // Poll Drive's changes feed from the server. Unlike Slack's Socket Mode, several servers can poll at once.
  sync: process.env.DRIVE_SYNC === "on",
  // The folder to ingest. Set the ID, or leave it empty to use the folder with this name in the admin's My Drive.
  rootFolderId: process.env.DRIVE_ROOT_FOLDER_ID || "",
  rootFolderName: process.env.DRIVE_ROOT_FOLDER_NAME || "Company A",
  pollSeconds: Number(process.env.DRIVE_POLL_SECONDS || 60),
  // Full reconcile (re-list everything, fix anything a poll missed) while the server runs. 0 turns it off.
  reconcileMinutes: Number(process.env.DRIVE_RECONCILE_MINUTES ?? 60),
  index: process.env.DRIVE_INDEX || "brain-drive",
  stateIndex: process.env.DRIVE_STATE_INDEX || "brain-drive-state",
  // Refresh token of the admin account that connected Drive (written by `npm run drive:connect`). Never commit it.
  tokenFile: process.env.GOOGLE_TOKEN_FILE || ".secrets/google-token.json",
};
