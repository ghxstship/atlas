import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the Cookie Policy, the Privacy Policy and the Data Retention and Deletion Policy say about
 * the marketing site at ghxstship.tech (issue 117), and about the visit counting the owner chose
 * for it on 2026-11-15. Each case holds a statement to what the
 * repository or the live site supports, so a later edit cannot bring back a claim nobody can source.
 */
const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const cookie = read("legal/cookie-policy.md");
const privacy = read("legal/privacy-policy.md");
const retention = read("legal/data-retention-and-deletion-policy.md");
const trace = read("legal/qa/requirements-trace.md");

/** The lines of a document that name the marketing site or its host's request log. */
const about = (text: string, pattern: RegExp) => text.split("\n").filter((l) => pattern.test(l));
const marketing = /marketing site/i;
/** A sentence that says a consent choice or decision is recorded on our servers. */
const recorded = /record(ed)?\b[^.]*on our servers/;

describe("the marketing site in the legal documents", () => {
  it("states of Vercel's request log only the IP address and the page requested", () => {
    const lines = [...about(cookie, /request log/), ...about(privacy, /request log/)];
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toContain("with your IP address and the page requested");
      // No repository document shows these fields or an account retention setting at Vercel.
      expect(line).not.toMatch(/user agent|details your browser sends|retention setting/i);
      expect(line).toContain("for the period its service sets for our plan");
      expect(line).toContain("Data Retention and Deletion Policy");
    }
  });

  it("gives that log a row in the retention schedule, so Privacy Policy 10 points at one", () => {
    const rows = about(retention, /Vercel's request log/);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("marketing site at https://ghxstship.tech");
    expect(rows[0]).toContain("IP address and page requested");
    expect(rows[0]).toContain("for the period its service sets for our plan");
    expect(privacy).toContain(
      "Our Data Retention and Deletion Policy sets out how long each kind of data is kept.",
    );
  });

  it("names no page of the marketing site, whose routes change without a policy version", () => {
    for (const line of about(cookie, marketing).concat(about(privacy, marketing))) {
      expect(line).not.toMatch(/\/(atlas|pricing|security|gateway|developers|about|contact)\b/);
      expect(line).not.toMatch(/has the pages|in English and Spanish/);
    }
  });

  it("says a choice is recorded on our servers only for Atlas and Gateway", () => {
    const lines = [...about(cookie, recorded), ...about(privacy, recorded)];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line, line.slice(0, 80)).toMatch(
        /On Atlas and Gateway|on Atlas and Gateway|no record of the choice on our servers/,
      );
    }
    expect(cookie).toContain(
      "On Atlas and Gateway we also record the decision on our servers as evidence.",
    );
    expect(privacy).toContain("and, on Atlas and Gateway, recorded on our servers as evidence");
    expect(privacy).toContain("keeps the choice only in that cookie");
  });

  it("qualifies the claim about other hosts while the Vercel Toolbar loader ships", () => {
    const line = about(cookie, /\*\*Marketing site\.\*\*/)[0] ?? "";
    expect(line).toContain("from another host");
    expect(line).toContain("vercel.live");
    expect(line).toContain("`__vercel_toolbar`");
  });

  it("states visit counting so that it is true before and after Vercel Web Analytics is turned on", () => {
    const line = about(cookie, /\*\*Marketing site\.\*\*/)[0] ?? "";
    // Off until the owner turns it on, and never before the effective date (OWNER_INPUTS F50).
    expect(line).toContain("runs no analytics until we turn on Vercel Web Analytics");
    expect(line).toContain("no earlier than 1 December 2026");
    // Same origin, so "no script from another host" stays true. Vercel serves the script under a
    // path it chooses per build, so the policy names the host and no path.
    expect(line).toContain("a script served from ghxstship.tech itself");
    expect(line).toContain("to no other host");
    expect(line).not.toMatch(/_vercel\/insights|va\.vercel-scripts\.com|vercel-insights\.com/);
    expect(line).toContain("sets no cookie and writes nothing to local storage or session storage");
    // What Vercel does on its servers is attributed to its documentation, which is all we can read.
    expect(line).toContain("Vercel's documentation states");
    // The documentation says the session is not kept beyond 24 hours; it does not say the hash is discarded.
    expect(line).toContain("does not keep a visitor session beyond 24 hours");
    expect(line).not.toContain("discards after 24 hours");
    // The use is stated as wide as what is collected and shown: referrer, place and device are
    // dimensions of the dashboard, so "only to see how many visits each page gets" was false.
    expect(line).not.toMatch(/use the counts only to see how many visits each page gets/);
    expect(line).toContain(
      "to see how many visits each page gets, where visits come from and on what kinds of device, and for nothing else",
    );
    // Global Privacy Control: the script is not loaded, before the banner and after it.
    expect(line).toContain(
      "does not load that script in a browser that sends a Global Privacy Control signal",
    );
    expect(line).toContain("counting runs only after you consent to Performance there");
    expect(line).not.toContain("It runs no analytics, and");

    const visits = about(privacy, /^\| Marketing site visits/)[0] ?? "";
    expect(visits).toContain("no earlier than 1 December 2026");
    expect(visits).toContain("A count names no person and no account");
    // Every field Vercel's Privacy and Compliance page lists is named, in both documents.
    for (const text of [line, visits]) {
      expect(text).toContain("the address and route of the page with its query parameters");
      expect(text).toContain("your browser and operating system and their versions");
      expect(text).toMatch(/country, region and city/);
      expect(text).toMatch(/the version of the (counting )?script/);
    }
    // Vercel guarantees the reporting window and may keep the data longer, so no end is stated.
    expect(visits).toContain(
      "for at least the reporting window of our plan and may keep them longer, as its documentation states",
    );
    expect(visits).toContain("A browser that sends Global Privacy Control is not counted");
    expect(privacy).not.toContain("no form and no analytics");
    expect(privacy).not.toContain("so the signal has nothing to turn off there");
    const basis = about(privacy, /^\| Count visits to the pages of the marketing site/)[0] ?? "";
    expect(basis).toContain(
      "legitimate interest in knowing which pages are read, where visits come from and on what kinds of device",
    );
    // The California notice at collection names the place derived for a count and its purpose.
    const place = about(privacy, /^\| Geolocation data/)[0] ?? "";
    expect(place).toContain("the country, region and city of a marketing site visit");
    expect(place).toContain("counting visits to the marketing site once visit counting is on");
    expect(privacy).toContain(
      "On Atlas and Gateway, non-essential analytics stay off until you consent.",
    );

    const counts = about(retention, /Page view counts for the marketing site/);
    expect(counts.length).toBe(1);
    expect(counts[0]).toContain("Vercel Web Analytics once it is turned on");
    expect(counts[0]).toContain(
      "for at least the reporting window of our plan; Vercel may keep it longer, as its documentation states",
    );
    expect(counts[0]).not.toContain("for the period its service sets for our plan");
    // That no count is tied to an IP address is Vercel's statement, not ours.
    expect(counts[0]).not.toContain("no IP address");
    expect(counts[0]).toContain(
      "Vercel's documentation states that no count is tied to an IP address",
    );
    expect(counts[0]).toContain("where visits come from and on what kinds of device");
  });

  it("leaves the Subprocessor List as it is, because the counts are not Customer Personal Data", () => {
    const list = read("legal/subprocessors.md");
    expect(list).toMatch(/^version: 1\.1\.1$/m);
    expect(list).not.toMatch(/Web Analytics|marketing site/i);
  });

  it("records as confirmed by the owner only what the owner decided", () => {
    const inputs = read("legal/OWNER_INPUTS.md");
    const row = (id: string) => about(inputs, new RegExp(`^\\| ${id} `))[0] ?? "";
    // F47 was confirmed before counting was written in; the call on counting is asked in F52 (g).
    expect(row("F47")).toContain("is an AI-made call the owner has not confirmed");
    expect(row("F52")).toContain("(g) the Subprocessor List stays at 1.1.1 with visit counting on");
    // Only the toolbar part of F49 is done; the check of the live site is not on record here.
    expect(row("F43")).not.toContain("and F49 is done");
    expect(row("F43")).toContain("The toolbar part of F49 is done");
    // The owner decides counting before the banner knowing the script reads local storage.
    expect(row("F52")).toContain("`__va_attribution`");
    expect(row("F52")).toContain("covers reading from a device as well as storing on it");
  });

  it("ends each sentence in the two trace rows that cite the marketing site", () => {
    const rows = about(trace, /^\| S14\.3-0[24] /);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).toContain("(ADR 0033 decision 54). The marketing site at ghxstship.tech");
      expect(row).not.toMatch(/\) [A-Z]/);
    }
  });

  it("carries the three versions in the registry with the date their frontmatter states", () => {
    const { documents } = parse(read("legal/index.yaml")) as {
      documents: {
        slug: string;
        version: string;
        file: string;
        history: { version: string; effective_date?: string }[];
      }[];
    };
    for (const [slug, version] of [
      ["cookie-policy", "1.1.0"],
      ["privacy-policy", "1.2.0"],
      ["data-retention-and-deletion-policy", "1.1.0"],
    ] as const) {
      const entry = documents.find((d) => d.slug === slug);
      expect(entry?.version, slug).toBe(version);
      const front = parse(read(entry?.file ?? "").split("---")[1] ?? "") as {
        version: string;
        effective_date: unknown;
      };
      expect(front.version).toBe(version);
      const day =
        front.effective_date instanceof Date
          ? front.effective_date.toISOString().slice(0, 10)
          : String(front.effective_date);
      expect(entry?.history[0]).toMatchObject({ version, effective_date: day });
    }
  });
});
