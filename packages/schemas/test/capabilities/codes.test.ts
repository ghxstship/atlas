import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CODES,
  CAPABILITY_CODES_MODULE,
  allCapabilities,
  loadCapabilityRegistry,
  renderCapabilityCodesModule,
} from "../../src/capabilities/index.ts";
import type { CapabilityCode } from "../../src/capabilities/index.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const registry = loadCapabilityRegistry();

describe("generated capability code module", () => {
  it("matches the generator output for capabilities.yaml", async () => {
    const modulePath = `${packageRoot}${CAPABILITY_CODES_MODULE}`;
    const options = (await resolveConfig(modulePath)) ?? {};
    expect(readFileSync(modulePath, "utf8")).toBe(
      await format(renderCapabilityCodesModule(registry), { ...options, filepath: modulePath }),
    );
  });

  it("lists every registry capability once, in registry order", () => {
    expect([...CAPABILITY_CODES]).toEqual(allCapabilities(registry).map((c) => c.code));
    expect(new Set(CAPABILITY_CODES).size).toBe(CAPABILITY_CODES.length);
  });

  it("types a registry code and refuses one the registry lacks", () => {
    const held: ReadonlySet<CapabilityCode> = new Set<CapabilityCode>(["work.record.read"]);
    expect(held.has("work.record.read")).toBe(true);
    // @ts-expect-error: work.record.reed is not in capabilities.yaml.
    expect(held.has("work.record.reed")).toBe(false);
  });
});
