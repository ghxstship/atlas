import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkLicenses,
  isAllowed,
  reviewLicenses,
  type LicenseException,
} from "../src/license-check.ts";

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

describe("reviewLicenses", () => {
  const sentry: LicenseException = {
    package: "sentry",
    license: "FSL-1.1-Apache-2.0",
    status: "Pending counsel",
    reason: "Build-time source map upload; not served to users.",
    decision: "gate-status owner decisions",
    recorded: "2026-10-21",
  };
  const libvips: LicenseException = {
    ...sentry,
    package: "@img/sharp-libvips-*",
    license: "LGPL-3.0-or-later",
    status: "Approved by counsel",
  };
  const byLicense = {
    MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }],
    "FSL-1.1-Apache-2.0": [
      { name: "sentry", versions: ["0.45.0"], license: "FSL-1.1-Apache-2.0" },
      { name: "other-fsl", versions: ["1.0.0"], license: "FSL-1.1-Apache-2.0" },
    ],
    "LGPL-3.0-or-later": [
      { name: "@img/sharp-libvips-linux-x64", versions: ["1.3.4"], license: "LGPL-3.0-or-later" },
    ],
    "GPL-3.0-only": [{ name: "sentry", versions: ["9.9.9"], license: "GPL-3.0-only" }],
  };

  it("excepts a package under its recorded license only, with platform builds by pattern", () => {
    const review = reviewLicenses(byLicense, [sentry, libvips]);
    expect(review.violations).toEqual([
      { license: "FSL-1.1-Apache-2.0", packages: ["other-fsl@1.0.0"] },
      { license: "GPL-3.0-only", packages: ["sentry@9.9.9"] },
    ]);
    expect(review.excepted.map((e) => [e.license, e.packages, e.exception.status])).toEqual([
      ["FSL-1.1-Apache-2.0", ["sentry@0.45.0"], "Pending counsel"],
      ["LGPL-3.0-or-later", ["@img/sharp-libvips-linux-x64@1.3.4"], "Approved by counsel"],
    ]);
    expect(review.unused).toEqual([]);
    expect(review.invalid).toEqual([]);
  });

  it("reports unused and malformed exceptions", () => {
    const review = reviewLicenses({ MIT: byLicense.MIT }, [
      sentry,
      { ...sentry, package: "" },
      { ...sentry, status: "Approved" as LicenseException["status"] },
      { ...sentry, reason: "short" },
      { ...sentry, decision: "" },
      { ...sentry, recorded: "today" },
    ]);
    expect(review.unused).toEqual([sentry]);
    expect(review.invalid).toHaveLength(5);
  });

  it("keeps the committed exceptions well formed and outside the allowlist", () => {
    const file = JSON.parse(
      readFileSync(new URL("../license-exceptions.json", import.meta.url), "utf8"),
    ) as { exceptions: LicenseException[] };
    expect(reviewLicenses({}, file.exceptions).invalid).toEqual([]);
    for (const e of file.exceptions) expect(isAllowed(e.license)).toBe(false);
  });
});
