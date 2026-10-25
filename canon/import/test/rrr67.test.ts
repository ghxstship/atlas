import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anonymize, parseRrr67 } from "../src/rrr67.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../../supabase/migrations/2001_anonymize_csmia26_client.sql");
const ruling = parseRrr67(read("../../rulings/rrr-67.yaml"));
const seed = readFileSync(
  new URL("../../../supabase/migrations/0150_xpms_canon_seed.sql", import.meta.url),
  "utf8",
);

// Owner decision of 2026-10-24 on Linear RRR-67: the client of the CSMIA26 activation is anonymized.
describe("RRR-67 anonymization", () => {
  it("replaces whole values first, then each phrase before the shorter phrase inside it", () => {
    expect(anonymize("Isabella")).toBe("Client");
    expect(anonymize("13-4029182")).toBe("00-0000000");
    expect(
      anonymize("Formal welcome remarks by Isabella Acker (Spotify) and Ashley Sumner (Tigre)"),
    ).toBe("Formal welcome remarks by the client lead and Ashley Sumner (Tigre)");
    expect(anonymize("Casa Spotify Wynwood Brand Toolkit & Style Guide")).toBe(
      "Brand House Wynwood Brand Toolkit & Style Guide",
    );
    expect(anonymize("BY OWNER (Spotify).")).toBe("BY OWNER (client).");
    expect(anonymize("isabella@spotify.com")).toBe("client.lead@example.com");
    expect(anonymize("Isabella Smith")).toBe("Isabella Smith");
    expect(anonymize("Truss steel is not delivered.")).toBe("Truss steel is not delivered.");
  });

  it("refuses a replacement that is not two non-empty strings", () => {
    expect(() => parseRrr67("replacements:\n  - [Spotify]\n")).toThrow(/two non-empty strings/);
    expect(() => parseRrr67('replacements:\n  - ["Spotify", ""]\n')).toThrow(
      /two non-empty strings/,
    );
  });

  it("matches migration 2001's anonymize and generalize functions, entry for entry and in order", () => {
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    for (const [from, to] of Object.entries(ruling.values))
      expect(migration).toContain(`when ${quote(from)} then ${quote(to)}`);
    const inOrder = (body: string, list: readonly (readonly [string, string])[]) => {
      let at = -1;
      for (const [from, to] of list) {
        const next = body.indexOf(`${quote(from)}, ${quote(to)}`, at + 1);
        expect(next, `${from} -> ${to}`).toBeGreaterThan(at);
        at = next;
      }
    };
    const anonymizer = migration.slice(
      migration.indexOf("private.rrr67_anonymize(p_value"),
      migration.indexOf("private.rrr67_generalize(p_value"),
    );
    const generalizer = migration.slice(migration.indexOf("private.rrr67_generalize(p_value"));
    inOrder(anonymizer, ruling.replacements);
    inOrder(generalizer, ruling.libraryReplacements);
    const pairs = migration.match(/^\s+'[^']*', '[^']*'\)[,;]?$/gm) ?? [];
    expect(pairs).toHaveLength(ruling.replacements.length + ruling.libraryReplacements.length);
  });

  it("generalizes a Standard Library value, and only a Standard Library value", () => {
    expect(anonymize("City of Miami Special Assembly Occupancy Permit", true)).toBe(
      "Special Assembly Occupancy Permit",
    );
    expect(anonymize("City of Miami Special Assembly Occupancy Permit")).toBe(
      "City of Miami Special Assembly Occupancy Permit",
    );
    expect(anonymize("Casa Spotify Wynwood Brand Toolkit & Style Guide", true)).toBe(
      "Client Brand Toolkit & Style Guide",
    );
  });

  it("leaves no trace of the client in the generated canon seed", () => {
    expect(seed).not.toMatch(/spotify/i);
    expect(seed).not.toMatch(/Isabella Acker|isabella@/);
  });
});
