/**
 * The tenant brand at runtime (Section 12 Mobile, A65-011 part 3): every override checked against the
 * design tokens' contrast pairs, with the platform brand as the fallback in any theme the accent fails.
 */
import { themes } from "@xos/ui-native/theme";
import { describe, expect, it } from "vitest";
import {
  brandColors,
  brandFromRow,
  chipColor,
  contrastFailures,
  logoFor,
  logoUrl,
  type OrgBrand,
} from "../src/domain/brand";

const ORG = "01920000-0000-7000-8000-000000000301";

function brand(accentHex: string | null, over: Partial<OrgBrand> = {}): OrgBrand {
  return {
    orgId: ORG,
    name: "Demo Staging Supply",
    accentHex,
    logoLightPath: null,
    logoDarkPath: null,
    ...over,
  };
}

describe("brand colors", () => {
  it("applies an accent that passes every pair in every theme, as text where it reads as text", () => {
    const colors = brandColors(brand("#B45309"));
    expect(Object.keys(colors)).toEqual(["dark", "light", "sunlight"]);
    expect(colors.dark).toEqual({ accentDefault: "#B45309" });
    // #2563EB reads as body text on the light grounds, so links and accent text take it too.
    expect(brandColors(brand("#2563EB")).light).toEqual({
      accentDefault: "#2563EB",
      accentText: "#2563EB",
    });
  });

  it("keeps the platform accent in each theme where the brand accent fails a pair", () => {
    // A deep green passes on light grounds but is too dark for the dark theme's surfaces.
    const green = brandColors(brand("#0B6E4F"));
    expect(green.dark).toBeUndefined();
    expect(green.light?.accentDefault).toBe("#0B6E4F");
    expect(contrastFailures("dark", { "accent-default": "#0B6E4F" }).map((f) => f.rule)).toContain(
      "Icons and state marks on grounds",
    );
    // White labels on yellow never pass: the platform accent stays everywhere.
    expect(brandColors(brand("#FFD400"))).toEqual({});
    expect(contrastFailures("light", { "accent-default": "#FFD400" })[0]).toMatchObject({
      rule: "Label on accent fill",
      fg: "accent-text-on",
      min: 4.5,
    });
  });

  it("passes the platform's own tokens untouched and ignores a missing or malformed accent", () => {
    for (const theme of ["dark", "light", "sunlight"] as const)
      expect(contrastFailures(theme, {})).toEqual([]);
    expect(brandColors(null)).toEqual({});
    expect(brandColors(brand(null))).toEqual({});
    expect(brandColors(brand("blue"))).toEqual({});
    expect(() =>
      contrastFailures("dark", { "accent-default": "#000000", "no-such-token": "#fff" }),
    ).not.toThrow();
  });

  it("names the brand chip color per theme, none where the accent fails", () => {
    expect(chipColor(brand("#0B6E4F"), "light")).toBe("#0B6E4F");
    expect(chipColor(brand("#0B6E4F"), "dark")).toBeNull();
    expect(chipColor(undefined, "dark")).toBeNull();
    // The fallback really is the platform's accent token.
    expect(themes.dark.color.accentDefault).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("brand rows and logos", () => {
  it("reads app.my_org_brands rows and refuses rows without an org or name", () => {
    expect(
      brandFromRow({
        org_id: ORG,
        name: "Demo Staging Supply",
        accent_hex: "#b45309",
        logo_light_path: `${ORG}/logo-light.png`,
        logo_dark_path: "",
      }),
    ).toEqual(brand("#B45309", { logoLightPath: `${ORG}/logo-light.png` }));
    expect(
      brandFromRow({ org_id: ORG, name: "X", accent_hex: "not a color" })?.accentHex,
    ).toBeNull();
    expect(brandFromRow({ name: "No org" })).toBeNull();
    expect(brandFromRow({ org_id: ORG })).toBeNull();
  });

  it("serves the logo for the theme from the public org-brand bucket", () => {
    const both = brand(null, {
      logoLightPath: `${ORG}/light.png`,
      logoDarkPath: `${ORG}/dark.png`,
    });
    expect(logoFor(both, true)).toBe(`${ORG}/dark.png`);
    expect(logoFor(both, false)).toBe(`${ORG}/light.png`);
    expect(logoFor(brand(null, { logoDarkPath: `${ORG}/dark.png` }), false)).toBe(
      `${ORG}/dark.png`,
    );
    expect(logoFor(null, true)).toBeNull();
    expect(logoUrl("https://api.example.test/", `${ORG}/light.png`)).toBe(
      `https://api.example.test/storage/v1/object/public/org-brand/${ORG}/light.png`,
    );
    expect(logoUrl("https://api.example.test", "../../etc/passwd")).toBeNull();
    expect(logoUrl("https://api.example.test", null)).toBeNull();
  });
});
