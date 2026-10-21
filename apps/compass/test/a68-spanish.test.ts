import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMessages, type locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { gateScanTitle } from "../src/domain/scan";

// Findings A68 saw in Compass while taking the store screenshots, fixed by A66.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function lookup(locale: (typeof locales)[number], key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages(locale),
    );
}

describe("A68 findings in Compass", () => {
  it("never leaves a gate scan headline ending in a bare middle dot", () => {
    expect(gateScanTitle("Access granted", null)).toBe("Access granted");
    expect(gateScanTitle("Access granted", undefined)).toBe("Access granted");
    expect(gateScanTitle("Access granted", "  ")).toBe("Access granted");
    expect(gateScanTitle("Access granted", "Ana Ruiz")).toBe("Access granted · Ana Ruiz");
    expect(gateScanTitle("Access denied", "This badge has expired.")).toBe(
      "Access denied · This badge has expired.",
    );
    expect(read("../app/(tabs)/scan.tsx")).not.toContain('holder_name ?? ""');
  });

  it("names every step of the access load in each language, never as the code's word", () => {
    const identity = read("../src/data/identity.ts");
    const steps = new Set(
      [...identity.matchAll(/new IdentityError\(\s*"([a-z]+)"/g)].map((m) => m[1]),
    );
    steps.add("access"); // CompassProvider's name for an error that names no step
    expect(steps.size).toBeGreaterThan(5);
    for (const locale of ["en-US", "es-US"] as const) {
      for (const step of steps) {
        const label = lookup(locale, `compass.signIn.identitySteps.${step}`);
        expect(typeof label, `${locale} ${step}`).toBe("string");
      }
    }
    expect(lookup("es-US", "compass.signIn.identitySteps.person")).toBe("tu perfil");
    expect(read("../app/_layout.tsx")).toContain("compass.signIn.identitySteps.${phase.step}");
  });

  it("gives Spanish Compass tabs short labels that match their screen titles", () => {
    expect(lookup("es-US", "nav.compass.tabs.inbox")).toBe("Bandeja");
    expect(lookup("es-US", "nav.compass.tabs.schedule")).toBe(
      lookup("es-US", "compass.schedule.title"),
    );
  });
});
