/**
 * The CycloneDX SBOM (Section 9 supply chain; `legal/open-source-licenses.md` section 3).
 *
 * `infra/security/sbom.sh` writes the SBOM with syft from an installed checkout. This module checks it is a
 * usable CycloneDX document and renders the third-party notices list that the Open Source Licenses page
 * promises from it: every npm component with its version and license, grouped by license.
 */

export interface CycloneDxLicenseChoice {
  readonly license?: { readonly id?: string; readonly name?: string };
  readonly expression?: string;
}

export interface CycloneDxComponent {
  readonly type?: string;
  readonly name: string;
  readonly group?: string;
  readonly version?: string;
  readonly purl?: string;
  readonly licenses?: readonly CycloneDxLicenseChoice[];
}

export interface CycloneDxBom {
  readonly bomFormat?: string;
  readonly specVersion?: string;
  readonly serialNumber?: string;
  readonly metadata?: {
    readonly component?: { readonly name?: string; readonly version?: string };
  };
  readonly components?: readonly CycloneDxComponent[];
}

export interface NpmComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

/** The fewest npm components a full SBOM of this repository has; fewer means the scan missed node_modules. */
export const MINIMUM_NPM_COMPONENTS = 500;

/** The SPDX expression of a component's license choices, or `Unknown`. */
export function licenseOf(component: CycloneDxComponent): string {
  const parts = (component.licenses ?? [])
    .map((choice) => choice.expression ?? choice.license?.id ?? choice.license?.name ?? "")
    .filter((part) => part !== "");
  const unique = [...new Set(parts)];
  if (unique.length === 0) return "Unknown";
  return unique.length === 1 ? (unique[0] ?? "Unknown") : unique.map((p) => `(${p})`).join(" OR ");
}

/** npm components, one per name and version, sorted. Workspace packages (`@xos/*`, the root) are ours, not third party. */
export function npmComponents(bom: CycloneDxBom): NpmComponent[] {
  const seen = new Map<string, NpmComponent>();
  for (const component of bom.components ?? []) {
    if (!component.purl?.startsWith("pkg:npm/")) continue;
    const name = component.group ? `${component.group}/${component.name}` : component.name;
    if (name === "xos" || name.startsWith("@xos/") || name === "xos-sdk") continue;
    const version = component.version ?? "";
    const key = `${name}@${version}`;
    if (!seen.has(key)) seen.set(key, { name, version, license: licenseOf(component) });
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** Problems that make the SBOM unusable; empty when it is fine. */
export function checkSbom(bom: CycloneDxBom): string[] {
  const problems: string[] = [];
  if (bom.bomFormat !== "CycloneDX")
    problems.push(`bomFormat is ${String(bom.bomFormat)}, not CycloneDX`);
  if (!/^1\.[4-9]$/.test(bom.specVersion ?? "")) {
    problems.push(`specVersion ${String(bom.specVersion)} is older than CycloneDX 1.4`);
  }
  const npm = npmComponents(bom);
  if (npm.length < MINIMUM_NPM_COMPONENTS) {
    problems.push(
      `only ${npm.length} npm components (expected at least ${MINIMUM_NPM_COMPONENTS}); was the checkout installed?`,
    );
  }
  const unversioned = npm.filter((c) => c.version === "");
  if (unversioned.length > 0) {
    problems.push(
      `${unversioned.length} npm components have no version, for example ${unversioned[0]?.name}`,
    );
  }
  return problems;
}

/** The third-party notices list, in Markdown, grouped by license. */
export function renderNotices(bom: CycloneDxBom, release: string): string {
  const byLicense = new Map<string, NpmComponent[]>();
  for (const component of npmComponents(bom)) {
    const list = byLicense.get(component.license) ?? [];
    list.push(component);
    byLicense.set(component.license, list);
  }
  const licenses = [...byLicense.keys()].sort((a, b) =>
    a === "Unknown" ? 1 : b === "Unknown" ? -1 : a.localeCompare(b),
  );
  const total = [...byLicense.values()].reduce((n, list) => n + list.length, 0);
  const spdx = (id: string) =>
    /^[A-Za-z0-9.+-]+$/.test(id) ? `[${id}](https://spdx.org/licenses/${id}.html)` : `\`${id}\``;
  return [
    `# Third-party components in XOS ${release}`,
    "",
    `Generated from the release's CycloneDX SBOM (\`xos-${release}.cdx.json\`, attached to the same release).`,
    `${total} npm components under ${licenses.length} licenses. Each package's own LICENSE file, in the package`,
    "on the npm registry, carries its copyright notice and full license text.",
    "",
    ...licenses.flatMap((license) => {
      const list = byLicense.get(license) ?? [];
      return [
        `## ${license === "Unknown" ? "No license declared" : license} (${list.length})`,
        "",
        ...(license === "Unknown" ? [] : [`License: ${spdx(license)}`, ""]),
        ...list.map((c) => `- ${c.name} ${c.version}`),
        "",
      ];
    }),
  ].join("\n");
}
