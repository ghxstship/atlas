// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The server and client split of the Marketing layer (design handoff section 10, ADR 0027), read
 * from the sources: a server component can import a module only when nothing it reaches calls a
 * hook or creates a context outside a client module.
 */
const src = fileURLToPath(new URL("../src/", import.meta.url));

/** The components a server component renders: no state, so no hooks and no context. */
const SERVER = [
  "ButtonLink",
  "MarketingSection",
  "MarketingHero",
  "ScreenshotFrame",
  "ProofStatStrip",
  "GateLifecycleRail",
  "SurfaceTriptych",
  "FeatureGrid",
  "ComparisonTable",
  "PriceDisplay",
  "FAQ",
  "Testimonial",
  "LogoSlotWall",
  "AIDisclosureBadge",
] as const;
const CLIENT = [
  "MarketingNav",
  "PersonaSwitcher",
  "PricingTable",
  "CodeSample",
  "MarketingFooter",
] as const;

describe("Marketing layer module boundaries", () => {
  it("keeps hooks and context out of every server-rendered module", () => {
    const visited = new Set<string>();
    const offending: string[] = [];
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const text = readFileSync(file, "utf8");
      if (/^"use client";/.test(text)) return;
      if (/lib\/context\.tsx|\buse[A-Z]\w*\(|createContext/.test(text)) offending.push(file);
      for (const match of text.matchAll(/from "(\.[^"]+\.tsx?)"/g)) {
        visit(fileURLToPath(new URL(match[1] ?? "", `file://${file}`)));
      }
    };
    for (const name of SERVER) visit(`${src}Marketing/${name}.tsx`);
    expect(offending.map((file) => file.slice(src.length))).toEqual([]);
    expect(visited.size).toBeGreaterThan(SERVER.length);
  });

  it("marks exactly the five stateful components, the provider bindings and the scroll region as client modules", () => {
    const client = readdirSync(`${src}Marketing`)
      .filter((file) => readFileSync(`${src}Marketing/${file}`, "utf8").startsWith('"use client";'))
      .sort();
    expect(client).toEqual(
      [...CLIENT.map((name) => `${name}.tsx`), "ComparisonScroll.tsx", "provided.tsx"].sort(),
    );
  });

  it("ships a README for each ported component", () => {
    for (const name of [...SERVER, ...CLIENT]) {
      expect(readFileSync(`${src}${name}/README.md`, "utf8")).toContain(`# ${name}`);
    }
  });
});
