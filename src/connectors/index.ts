// The only place that knows which platforms exist. Search and Ask run over whatever is registered here.
// Adding a platform: implement Connector in src/connectors/<name>/ and add it below.
import { slack } from "./slack/index.js";
import type { Connector } from "./types.js";

// Drive loads only when the Google app is configured, so the server still runs without Google credentials.
export const driveConfigured =
  /\.apps\.googleusercontent\.com$/.test(process.env.GOOGLE_CLIENT_ID ?? "") &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !process.env.GOOGLE_CLIENT_SECRET.endsWith("...");

export const connectors: Connector[] = [
  slack,
  ...(driveConfigured ? [(await import("./drive/index.js")).drive] : []),
];

export const connectorByName = (name: string) => connectors.find((c) => c.name === name);
