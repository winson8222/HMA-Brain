import { describe, expect, it } from "vitest";
import { localDate, localDateOf, localDateTime } from "../time.js";

// config.timeZone defaults to Asia/Singapore (UTC+8).
describe("local times for the prompt", () => {
  it("gives a Slack timestamp in Singapore time, with the zone named", () => {
    expect(localDateTime("2026-10-03T12:39:35.000Z")).toBe("2026-10-03 20:39 SGT");
  });

  it("rolls the date over at local midnight, not UTC midnight", () => {
    expect(localDate(new Date("2026-10-03T17:30:00Z"))).toBe("2026-10-04");
    expect(localDateOf("2026-10-03T17:30:00Z")).toBe("2026-10-04");
  });

  it("handles missing or bad times", () => {
    expect(localDateTime(null)).toBe("");
    expect(localDateOf(undefined)).toBe("unknown");
    expect(localDateOf("not a date")).toBe("unknown");
  });
});
