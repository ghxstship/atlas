import { describe, expect, it } from "vitest";
import {
  checkSbom,
  licenseOf,
  MINIMUM_NPM_COMPONENTS,
  npmComponents,
  renderNotices,
  type CycloneDxBom,
  type CycloneDxComponent,
} from "../src/sbom.ts";

const npm = (name: string, version: string, licenses?: CycloneDxComponent["licenses"]) => ({
  type: "library",
  name,
  version,
  purl: `pkg:npm/${name.replace("@", "%40")}@${version}`,
  ...(licenses === undefined ? {} : { licenses }),
});

describe("licenseOf", () => {
  it("reads ids, names and expressions, and says Unknown when there are none", () => {
    expect(licenseOf(npm("a", "1", [{ license: { id: "MIT" } }]))).toBe("MIT");
    expect(licenseOf(npm("a", "1", [{ expression: "(MIT OR Apache-2.0)" }]))).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(
      licenseOf(npm("a", "1", [{ license: { name: "Custom" } }, { license: { id: "MIT" } }])),
    ).toBe("(Custom) OR (MIT)");
    expect(licenseOf(npm("a", "1", [{ license: { id: "MIT" } }, { license: { id: "MIT" } }]))).toBe(
      "MIT",
    );
    expect(licenseOf(npm("a", "1"))).toBe("Unknown");
    expect(licenseOf(npm("a", "1", [{}]))).toBe("Unknown");
  });
});

describe("npmComponents", () => {
  it("keeps third-party npm components once each, sorted, with group names joined", () => {
    const bom: CycloneDxBom = {
      components: [
        npm("zod", "4.6.5", [{ license: { id: "MIT" } }]),
        npm("zod", "4.6.5", [{ license: { id: "MIT" } }]),
        {
          name: "react",
          group: "@types",
          version: "19.0.0",
          purl: "pkg:npm/%40types/react@19.0.0",
        },
        npm("@xos/ui", "0.0.0"),
        npm("xos", "0.0.0"),
        { name: "requests", version: "2.32.0", purl: "pkg:pypi/requests@2.32.0" },
        { name: "no-purl", version: "1.0.0" },
      ],
    };
    expect(npmComponents(bom).map((c) => `${c.name}@${c.version} ${c.license}`)).toEqual([
      "@types/react@19.0.0 Unknown",
      "zod@4.6.5 MIT",
    ]);
  });
});

describe("checkSbom", () => {
  const many = Array.from({ length: MINIMUM_NPM_COMPONENTS }, (_, i) =>
    npm(`package-${i}`, "1.0.0", [{ license: { id: "MIT" } }]),
  );

  it("accepts a CycloneDX 1.4 or later document with enough versioned npm components", () => {
    expect(checkSbom({ bomFormat: "CycloneDX", specVersion: "1.7", components: many })).toEqual([]);
  });

  it("reports the wrong format, an old spec, too few components and missing versions", () => {
    expect(
      checkSbom({
        bomFormat: "SPDX",
        specVersion: "1.2",
        components: [{ name: "a", purl: "pkg:npm/a@" }],
      }),
    ).toEqual([
      "bomFormat is SPDX, not CycloneDX",
      "specVersion 1.2 is older than CycloneDX 1.4",
      `only 1 npm components (expected at least ${MINIMUM_NPM_COMPONENTS}); was the checkout installed?`,
      "1 npm components have no version, for example a",
    ]);
  });
});

describe("renderNotices", () => {
  it("groups components by license, Unknown last, with SPDX links", () => {
    const notices = renderNotices(
      {
        components: [
          npm("b", "2.0.0", [{ license: { id: "MIT" } }]),
          npm("a", "1.0.0", [{ license: { id: "Apache-2.0" } }]),
          npm("c", "3.0.0"),
          npm("d", "4.0.0", [{ expression: "(MIT OR GPL-3.0)" }]),
        ],
      },
      "4.0.0",
    );
    expect(notices).toContain("# Third-party components in XOS 4.0.0");
    expect(notices).toContain("4 npm components under 4 licenses.");
    expect(notices.indexOf("## Apache-2.0 (1)")).toBeLessThan(notices.indexOf("## MIT (1)"));
    expect(notices.indexOf("## MIT (1)")).toBeLessThan(
      notices.indexOf("## No license declared (1)"),
    );
    expect(notices).toContain("License: [MIT](https://spdx.org/licenses/MIT.html)");
    expect(notices).toContain("License: `(MIT OR GPL-3.0)`");
    expect(notices).toContain("- c 3.0.0");
  });
});
