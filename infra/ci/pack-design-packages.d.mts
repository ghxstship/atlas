/** Types for pack-design-packages.mjs, which runs on plain Node in the release workflow. */

export interface PackageManifest {
  name?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [field: string]: unknown;
}

export interface FontFamily {
  token: string;
  family: string;
  alsoNamed: string[];
  weights: number[];
  style: string;
  license: string;
  files: { variable: string[]; static: string[] };
}

export interface RemoteReference {
  url: string;
  through: "import" | "url" | "text";
}

export const PACKAGES: string[];
export const TEXT_ONLY_REFERENCES: { url: RegExp; files: RegExp }[];
export function publishedName(pkg: string): string;
export function archiveName(pkg: string, version: string): string;
export function publishManifest(
  manifest: PackageManifest,
  pkg: string,
  version: string,
): PackageManifest;
export function fontsSection(fonts: { families: FontFamily[] }, pkg: string): string[];
export function remoteReferences(file: string, source: string): RemoteReference[];
export function textOnly(pkg: string, file: string, url: string): boolean;
export function remoteProblems(pkg: string, file: string, source: string): string[];
export function problems(
  dir: string,
  files: string[],
  manifest: PackageManifest,
  workspaceName: string,
): string[];
