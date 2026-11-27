import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * docs/support-channels.md is the file the marketing site cites for support channels, hours and plans
 * (ghxstship/atlas issue 126). It states nothing of its own, so each test here holds one part of it to the file it
 * restates: the Service Level Agreement, the Terms of Service, the Contact page and the product.
 */
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${repo}${path}`, "utf8");
const doc = read("docs/support-channels.md");

/** The cells of every body row of the first Markdown table under a heading. */
function tableUnder(text: string, heading: string): string[][] {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const lines = text.slice(start + heading.length + 2).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const length = lines.slice(first).findIndex((line) => !line.startsWith("|"));
  return lines.slice(first + 2, length === -1 ? undefined : first + length).map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

describe("docs/support-channels.md", () => {
  it("quotes every source sentence exactly as its file holds it", () => {
    const sources = tableUnder(doc, "## Sources");
    expect(sources.length).toBeGreaterThanOrEqual(10);
    for (const [file = "", sentence = ""] of sources) {
      const path = file.replaceAll("`", "");
      expect(read(path), `${path} holds: ${sentence}`).toContain(sentence);
    }
  });

  it("gives each plan the channels and first response target of the Service Level Agreement, section 6", () => {
    const agreed = tableUnder(
      read("legal/service-level-agreement.md"),
      "## 6. Support Response Targets",
    );
    expect(agreed.map(([plan]) => plan)).toEqual(["Access", "Core", "Pro", "Team", "Enterprise"]);
    expect(tableUnder(doc, "## First response targets by plan")).toEqual(agreed);
  });

  it("states the business hours the Service Level Agreement states", () => {
    expect(read("legal/service-level-agreement.md")).toContain(
      "Business hours are 9:00 a.m. to 5:00 p.m. New York time, and business days are Monday to Friday, except US federal holidays, in New York time.",
    );
    expect(doc).toContain(
      "Business hours are 9:00 a.m. to 5:00 p.m. New York time, Monday to Friday, except US federal holidays.",
    );
  });

  it("names only the addresses the Contact page publishes, each for its purpose", () => {
    const contact = read("legal/contact.md");
    expect(contact).toContain(
      "| Help with Atlas, Gateway, Compass or the API     | support@ghxstship.pro | Support        |",
    );
    expect(contact).toContain("docs.ghxstship.tech");
    const addresses = new Set(doc.match(/[a-z]+@[a-z.]+\.[a-z]+/g));
    expect([...addresses].sort()).toEqual(["sos@ghxstship.pro", "support@ghxstship.pro"]);
    const channels = tableUnder(doc, "## Channels");
    expect(channels.map(([channel]) => channel)).toEqual([
      "Help center",
      "Email",
      "Email, priority queue",
      "Contact support in the app",
      "Dedicated channel, named contact and phone for severity 1 incidents",
      "Account and billing email",
    ]);
    for (const row of channels) expect(row.every((cell) => cell.length > 0)).toBe(true);
  });

  it("gives platform support in the app to the plans the database gives it to", () => {
    const terms = read("supabase/migrations/0643_support_tickets.sql");
    const body = terms.slice(
      terms.indexOf("create or replace function private.platform_support_terms"),
      terms.indexOf("comment on function private.platform_support_terms"),
    );
    const plans = [
      ...body.matchAll(/when '([a-z]+)' then '[A-Za-z ]+'::app\.support_channel/g),
    ].map((m) => m[1]);
    expect(plans).toEqual(["core", "pro", "team", "enterprise"]);
    const later = read("supabase/migrations/1592_support_channels_without_forum.sql");
    expect(later).not.toContain("function private.platform_support_terms");
    expect(
      tableUnder(doc, "## Channels").find(([c]) => c === "Contact support in the app")?.[2],
    ).toBe("Core, Pro, Team and Enterprise, for an organization's admins");
  });

  it("is named in the lockstep contract as a file the marketing site reads", () => {
    expect(read("design/MARKETING_LOCKSTEP.md")).toContain("`docs/support-channels.md`");
  });
});
