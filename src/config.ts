import "dotenv/config";
import { randomBytes } from "node:crypto";

const port = Number(process.env.PORT ?? 3000);

export const config = {
  esUrl: process.env.ES_URL ?? "http://localhost:9200",
  esIndex: process.env.ES_INDEX ?? "brain",
  port,
  captureEvents: process.env.CAPTURE_EVENTS === "1",
  // Live Slack sync, off unless SLACK_SYNC=on. Only ONE server per Slack app should have it on:
  // Slack sends each event to just one open connection, so extra listeners would split the events.
  slackSync: process.env.SLACK_SYNC === "on",
  // Where people reach this app. Slack sends people back here after they approve Connect.
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  // on: the UI may act as any person (demo compare). off: only "Me" (the signed-in person).
  allowImpersonation: process.env.ALLOW_IMPERSONATION !== "off",
  // Signs the login cookie. If unset, a random one is used and everyone is signed out on restart.
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  sessionSecretIsRandom: !process.env.SESSION_SECRET,
  tokensFile: process.env.SLACK_TOKENS_FILE ?? "slack-tokens.json",
  // The company's time zone: times in the model's prompt (and "today") are given in it, with the zone named.
  timeZone: process.env.TIME_ZONE || "Asia/Singapore",

  // Hybrid retrieval knobs (see src/hybrid.ts; mode itself is resolved there, lazily from env)
  hybridCandidates: Number(process.env.HYBRID_CANDIDATES ?? 50),
  rrfK: Number(process.env.RRF_K ?? 60),
  fuseTop: Number(process.env.FUSE_TOP ?? 20),
  embeddingBatch: Number(process.env.EMBEDDING_BATCH ?? 64),
  // Vector dimension of EMBEDDING_MODEL. Required for hybrid search: it sets the index mapping,
  // so changing it needs `npm run backfill`.
  embeddingDims: process.env.EMBEDDING_DIMS ? Number(process.env.EMBEDDING_DIMS) : undefined,
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.endsWith("...")) {
    console.error(`Missing ${name} in .env (see .env.example and README.md)`);
    process.exit(1);
  }
  return v;
}
