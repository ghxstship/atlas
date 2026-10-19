import { describe, expect, it } from "vitest";
import { getMessages } from "../src/index.ts";
import { flatten, type Catalog } from "./icu.ts";

/**
 * Spanish terminology (owner decision 27, ADR 0033): a project gate is a "compuerta". "Puerta" stays
 * only where English means a physical door or gate: guest door lists, occupancy counted at the doors,
 * the vehicle gate in logistics and Compass, and a venue gate named in an example.
 */
const PHYSICAL_GATE_KEYS: ReadonlySet<string> = new Set([
  "activity.subjects.gate_queue",
  "compass.sync.tables.gate_queue",
  "compass.queue.kinds.gate_queue",
  "compass.queue.summary.gateArrival",
  "compass.queue.summary.vehicleRelease",
  "compass.incidents.titleHelp",
  "compass.logistics.gate.title",
  "compass.logistics.gate.empty",
  "incidents.mediaUriHelp",
  "logistics.shipments.progress.at-gate",
  "logistics.shipments.gate.title",
  "logistics.shipments.gate.empty",
  "logistics.yard.gateTitle",
  "logistics.yard.emptyQueue",
  "logistics.yard.emptyQueueReadOnly",
  "shell.pages.places.sitePlans.empty",
]);

describe("es-US gate terminology", () => {
  const en = flatten(getMessages("en-US") as Catalog);
  const es = flatten(getMessages("es-US") as Catalog);
  const gateKeys = [...en].filter(([, text]) => /\bgates?\b/i.test(text)).map(([key]) => key);

  it("finds the gate messages", () => {
    expect(gateKeys.length).toBeGreaterThan(40);
  });

  it.each(gateKeys.filter((key) => !PHYSICAL_GATE_KEYS.has(key)))(
    "%s calls a project gate a compuerta",
    (key) => {
      const text = es.get(key) ?? "";
      expect(text).toMatch(/compuerta/i);
      expect(text).not.toMatch(/\bpuertas?\b/i);
      expect(text.replace(/\{\s*gate\b/g, "{"), "no English gate").not.toMatch(/\bgates?\b/i);
    },
  );

  it("keeps puerta for physical doors and gates", () => {
    const doorKeys = [...en].filter(([, text]) => /\bdoors?\b/i.test(text)).map(([key]) => key);
    expect(doorKeys.length).toBeGreaterThan(0);
    for (const key of [...doorKeys, ...PHYSICAL_GATE_KEYS]) {
      expect(es.get(key), key).not.toMatch(/compuerta/i);
    }
  });
});
