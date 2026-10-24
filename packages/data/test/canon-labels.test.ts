import { describe, expect, it } from "vitest";
import { CANON_VOCABULARIES, listCanonLabels, withCanonLabels } from "../src/canon-labels.ts";
import { getProjectUnitSystem } from "../src/jurisdiction-units.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Section 15 canon labels in a locale and the unit system of a project's jurisdiction (ADR 0053). */

describe("canon labels", () => {
  it("reads a vocabulary's labels in a locale through xpms.canon_labels", async () => {
    const { db, calls } = fakeClient({
      "rpc:xpms.canon_labels": [
        okResponse([
          { code: "SCP", label: "Alcance", locale_code: "es-US", translated: true },
          { code: "ADV", label: "Advance", locale_code: "en-US", translated: false },
        ]),
      ],
    });
    const labels = await listCanonLabels(db, "phase", "es-US");
    expect(labels.ok && [...labels.data]).toEqual([
      ["SCP", "Alcance"],
      ["ADV", "Advance"],
    ]);
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_vocabulary: "phase", p_locale: "es-US" }]]);
  });

  it("reports a failed read", async () => {
    const { db } = fakeClient({
      "rpc:xpms.canon_labels": [errorResponse("22023", "canon_labels: unknown vocabulary")],
    });
    expect((await listCanonLabels(db, "phase", "es-US")).ok).toBe(false);
  });

  it("relabels rows by code and keeps the English where there is no label", () => {
    const rows = [
      { code: "0000", name: "Executive" },
      { code: "1000", name: "Creative" },
    ];
    const out = withCanonLabels(
      rows,
      new Map([["0000", "Dirección"]]),
      (r) => r.code,
      (r, name) => ({ ...r, name }),
    );
    expect(out).toEqual([
      { code: "0000", name: "Dirección" },
      { code: "1000", name: "Creative" },
    ]);
  });

  it("names the twenty vocabularies migration 1541 registers", () => {
    expect(CANON_VOCABULARIES).toHaveLength(20);
    expect(CANON_VOCABULARIES).toContain("jobTitle");
  });
});

describe("a project's unit system", () => {
  it("reads the project's jurisdiction, then its venue's, through jurisdiction_resolved", async () => {
    const own = fakeClient({
      "from:projects": [
        okResponse({ jurisdiction_id: "GB", venues: { jurisdiction_id: "US-FL" } }),
      ],
      "from:xpms.jurisdiction_resolved": [okResponse({ unit_system: "metric" })],
    });
    expect(await getProjectUnitSystem(own.db, "p")).toEqual({ ok: true, data: "metric" });
    expect(own.calls[1]?.steps).toContainEqual(["eq", ["jurisdiction_id", "GB"]]);

    const venue = fakeClient({
      "from:projects": [
        okResponse({ jurisdiction_id: null, venues: { jurisdiction_id: "US-FL" } }),
      ],
      "from:xpms.jurisdiction_resolved": [okResponse({ unit_system: "imperial" })],
    });
    expect(await getProjectUnitSystem(venue.db, "p")).toEqual({ ok: true, data: "imperial" });
    expect(venue.calls[1]?.steps).toContainEqual(["eq", ["jurisdiction_id", "US-FL"]]);
  });

  it("answers null when no jurisdiction is known, and reports errors", async () => {
    const none = fakeClient({
      "from:projects": [okResponse({ jurisdiction_id: null, venues: null })],
    });
    expect(await getProjectUnitSystem(none.db, "p")).toEqual({ ok: true, data: null });
    const broken = fakeClient({ "from:projects": [errorResponse("42501", "denied")] });
    expect((await getProjectUnitSystem(broken.db, "p")).ok).toBe(false);
  });
});
