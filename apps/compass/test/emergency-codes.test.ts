import { readFileSync } from "node:fs";
import { themeNames, themeTokens } from "@xos/ui-native/theme";
import { describe, expect, it } from "vitest";
import {
  emergencyCodesFor,
  needsCodeWord,
  spokenCode,
  swatchToken,
  type CanonEmergencyCodeRow,
  type OrgEmergencyCodeRow,
} from "../src/domain/emergencyCodes";

const canon: CanonEmergencyCodeRow[] = [
  {
    id: "CODE_BLUE",
    label: "Code Blue",
    emergency: "Medical",
    swatch: "ecode-blue",
    sort_order: 2,
  },
  { id: "CODE_RED", label: "Code Red", emergency: "Fire", swatch: "ecode-red", sort_order: 1 },
  {
    id: "CODE_ADAM",
    label: "Code Adam",
    emergency: "Missing child",
    swatch: "ecode-adam",
    sort_order: 2,
  },
];

function own(rows: Partial<OrgEmergencyCodeRow>[]): OrgEmergencyCodeRow[] {
  return rows.map((r, i) => ({
    id: `ec-${i}`,
    org_id: "org-1",
    code: "CODE_RED",
    label: "Fire",
    emergency: "Fire",
    sort_order: 1,
    ...r,
  }));
}

describe("emergency codes in Reference (WP18)", () => {
  it("lists the org's own labels, descriptions and order, with the canon code word and swatch", () => {
    const list = emergencyCodesFor(
      own([
        {
          code: "CODE_RED",
          label: "Fire on site",
          emergency: "Leave by the nearest exit",
          sort_order: 2,
        },
        { code: "CODE_BLUE", label: "Medical", emergency: "Call the medic tent", sort_order: 1 },
      ]),
      canon,
    );
    expect(list.standard).toBe(false);
    expect(list.codes).toEqual([
      {
        key: "ec-1",
        code: "CODE_BLUE",
        label: "Medical",
        emergency: "Call the medic tent",
        swatch: "ecode-blue",
        sortOrder: 1,
      },
      {
        key: "ec-0",
        code: "CODE_RED",
        label: "Fire on site",
        emergency: "Leave by the nearest exit",
        swatch: "ecode-red",
        sortOrder: 2,
      },
    ]);
  });

  it("breaks a tie in the org's order by code word, as Atlas does", () => {
    const list = emergencyCodesFor(
      own([
        { code: "CODE_RED", sort_order: 1 },
        { code: "CODE_ADAM", sort_order: 1 },
      ]),
      canon,
    );
    expect(list.codes.map((c) => c.code)).toEqual(["CODE_ADAM", "CODE_RED"]);
  });

  it("shows the canon codes in canon order, marked as standard, while the org holds none", () => {
    const list = emergencyCodesFor([], canon);
    expect(list.standard).toBe(true);
    expect(list.codes.map((c) => [c.code, c.label, c.swatch])).toEqual([
      ["CODE_RED", "Code Red", "ecode-red"],
      ["CODE_ADAM", "Code Adam", "ecode-adam"],
      ["CODE_BLUE", "Code Blue", "ecode-blue"],
    ]);
  });

  it("does not take canon rows an earlier build stored in the org table for the org's codes", () => {
    // Before WP18 the canon codes were cached in emergency_codes with no org; an offline launch after the upgrade
    // still holds them until the next online refresh narrows the store.
    const leftover = [
      { id: "CODE_RED", code: "CODE_RED", label: "Code Red" },
    ] as unknown as OrgEmergencyCodeRow[];
    const list = emergencyCodesFor(leftover, canon);
    expect(list.standard).toBe(true);
    expect(list.codes.map((c) => c.swatch)).toEqual(["ecode-red", "ecode-adam", "ecode-blue"]);
  });

  it("shows nothing before either list has downloaded", () => {
    expect(emergencyCodesFor([], [])).toEqual({ codes: [], standard: true });
  });

  it("leaves the swatch out while the canon codes are not on the device, never borrowing Code Grey's", () => {
    const list = emergencyCodesFor(own([{ code: "CODE_RED" }, { code: "CODE_BLUE" }]), []);
    expect(list.codes.map((c) => c.swatch)).toEqual([null, null]);
    expect(swatchToken(null)).toBeNull();
  });

  it("names the theme color of a swatch, and nothing for a name that is not one", () => {
    expect(swatchToken("ecode-red")).toBe("ecodeRed");
    expect(swatchToken("ecode-adam")).toBe("ecodeAdam");
    expect(swatchToken("not-a-swatch")).toBeNull();
    expect(swatchToken("")).toBeNull();
  });

  it("writes the code word as it is said on the radio, unless the label already says it", () => {
    expect(spokenCode("CODE_RED")).toBe("CODE RED");
    expect(needsCodeWord("CODE_RED", "Code Red")).toBe(false);
    expect(needsCodeWord("CODE_RED", "Fire on site")).toBe(true);
    expect(needsCodeWord("CODE_ADAM", "Code  Adam ")).toBe(false);
  });

  it("finds a color in every theme for every swatch the tokens define", () => {
    const tokens = readFileSync(
      new URL("../../../packages/tokens/xos.tokens.json", import.meta.url),
      "utf8",
    );
    const swatches = [...new Set(tokens.match(/ecode-[a-z]+/g) ?? [])];
    expect(swatches.length).toBeGreaterThan(10);
    for (const theme of themeNames) {
      const colors = themeTokens[theme].color as Readonly<Record<string, string>>;
      expect(
        swatches.filter((s) => typeof colors[swatchToken(s) ?? ""] !== "string"),
        theme,
      ).toEqual([]);
    }
  });
});
