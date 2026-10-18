import { describe, expect, it } from "vitest";
import { checkLicenses, isAllowed } from "../src/license-check.ts";

describe("isAllowed", () => {
  it("accepts allowlisted identifiers and their aliases", () => {
    expect(isAllowed("MIT")).toBe(true);
    expect(isAllowed("MIT/X11")).toBe(true);
    expect(isAllowed("BlueOak-1.0.0")).toBe(true);
  });

  it("passes a dual license on its permissive option", () => {
    expect(isAllowed("(MIT OR GPL-3.0-or-later)")).toBe(true);
    expect(isAllowed("(BSD-3-Clause OR GPL-2.0)")).toBe(true);
  });

  it("needs every term of a conjunction", () => {
    expect(isAllowed("(MIT AND Zlib)")).toBe(true);
    expect(isAllowed("MIT and ISC")).toBe(true);
    expect(isAllowed("MIT AND GPL-3.0-only")).toBe(false);
    expect(isAllowed("(MIT OR Apache-2.0) AND (ISC OR LGPL-3.0-or-later)")).toBe(true);
    expect(isAllowed("(MIT OR Apache-2.0) AND (GPL-2.0 OR LGPL-3.0-or-later)")).toBe(false);
  });

  it("refuses copyleft, source-available and unknown licenses", () => {
    expect(isAllowed("LGPL-3.0-or-later")).toBe(false);
    expect(isAllowed("FSL-1.1-Apache-2.0")).toBe(false);
    expect(isAllowed("Unknown")).toBe(false);
  });
});

describe("checkLicenses", () => {
  it("groups the packages that need review by license", () => {
    expect(
      checkLicenses({
        MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }],
        Unknown: [
          { name: "z", versions: ["0.1.0"], license: "Unknown" },
          { name: "b", versions: ["2.0.0", "2.1.0"], license: "Unknown" },
        ],
        "GPL-3.0-only": [{ name: "c", versions: ["3.0.0"], license: "GPL-3.0-only" }],
      }),
    ).toEqual([
      { license: "GPL-3.0-only", packages: ["c@3.0.0"] },
      { license: "Unknown", packages: ["b@2.0.0,2.1.0", "z@0.1.0"] },
    ]);
  });
});
