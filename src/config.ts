import "dotenv/config";

export const config = {
  esUrl: process.env.ES_URL ?? "http://localhost:9200",
  esIndex: process.env.ES_INDEX ?? "brain",
  port: Number(process.env.PORT ?? 3000),
  captureEvents: process.env.CAPTURE_EVENTS === "1",
  // Live Slack sync. Only ONE server per Slack app should have this on: Slack sends each
  // event to just one open connection, so extra listeners would split the events.
  slackSync: process.env.SLACK_SYNC !== "off",
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.endsWith("...")) {
    console.error(`Missing ${name} in .env (see .env.example and the Slack setup in README.md)`);
    process.exit(1);
  }
  return v;
}
