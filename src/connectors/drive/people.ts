// The demo people, from the persona emails in .env: who you can "ask as" in the Drive UI and CLI,
// and who seed:drive shares with. Demo only: a real deployment takes identity from the login session.
export type Persona = "alice" | "bob" | "carol" | "dave";
export const PERSONAS: Persona[] = ["alice", "bob", "carol", "dave"];

export type Person = { name: string; email: string; admin: boolean; role: string };

// Their part in the demo story (mirrors the Slack seed).
const ROLES: Record<Persona, string> = { alice: "Payments engineer", bob: "Engineer", carol: "Security lead", dave: "Contractor" };

const PLACEHOLDERS = new Set(["you@gmail.com"]);

export const isRealEmail = (e?: string | null): e is string =>
  !!e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim()) && !e.endsWith("...") && !PLACEHOLDERS.has(e.trim().toLowerCase());

export function personaEmail(p: Persona): string | null {
  const e = process.env[`${p.toUpperCase()}_EMAIL`];
  return isRealEmail(e) ? e.trim().toLowerCase() : null;
}

const title = (p: string) => p[0].toUpperCase() + p.slice(1);

// The personas that have an email, plus the admin account the crawler runs as.
export function demoPeople(admin: string | null): Person[] {
  const out: Person[] = [];
  for (const p of PERSONAS) {
    const email = personaEmail(p);
    if (email && !out.some((x) => x.email === email)) out.push({ name: title(p), email, admin: email === admin, role: ROLES[p] });
  }
  if (admin && !out.some((x) => x.email === admin)) out.push({ name: "Drive admin", email: admin, admin: true, role: "Owns every file" });
  return out;
}

// "bob", "Bob" or "bob@example.com" → that person, if they're one of the demo people.
export function findPerson(who: string, people: Person[]): Person | null {
  const w = who.trim().toLowerCase();
  return people.find((p) => p.email === w || p.name.toLowerCase() === w || (w === "admin" && p.admin)) ?? null;
}

// Things about the demo setup that make the permission story wrong or incomplete.
export function setupWarnings(admin: string | null): string[] {
  const out: string[] = [];
  const persona = PERSONAS.find((p) => personaEmail(p) === admin);
  if (persona) {
    out.push(
      `${title(persona)} is also the Drive admin, so ${title(persona)} owns every file and can see all of them. ` +
        "Connect a separate admin account before the real demo (docs/drive-setup.md, “Switch to a dedicated admin”).",
    );
  }
  for (const p of PERSONAS) {
    if (!personaEmail(p)) {
      out.push(`${p.toUpperCase()}_EMAIL isn't set, so ${title(p)} isn't in the demo, and files meant only for ${title(p)} are visible to the admin alone.`);
    }
  }
  return out;
}
