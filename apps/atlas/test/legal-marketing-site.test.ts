import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the Cookie Policy, the Privacy Policy and the Data Retention and Deletion Policy say about
 * the marketing site at ghxstship.tech (issue 117). Each case holds a statement to what the
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
    const rows = about(retention, /Vercel/);
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
