// Times as the company reads them, for the model's prompt. Stored times stay UTC; the model gets local
// times with the zone named, so "20:39 SGT" in a message and the message's own timestamp agree.
import { config } from "./config.js";

const zoneName = (d: Date) =>
  new Intl.DateTimeFormat("en-SG", { timeZone: config.timeZone, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? config.timeZone;

const valid = (iso?: string | null): Date | null => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

// "2026-10-03"
export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: config.timeZone });

// "2026-10-03 20:39 SGT", or "" if there's no time.
export function localDateTime(iso?: string | null): string {
  const d = valid(iso);
  if (!d) return "";
  const time = d.toLocaleTimeString("en-GB", { timeZone: config.timeZone, hour: "2-digit", minute: "2-digit" });
  return `${localDate(d)} ${time} ${zoneName(d)}`;
}

// "2026-10-03", or "unknown".
export const localDateOf = (iso?: string | null) => {
  const d = valid(iso);
  return d ? localDate(d) : "unknown";
};
