/**
 * Publish readiness of the three public packages (Wave 7): @ghxstship/xos-sdk, @ghxstship/xos-cli and
 * xos-sdk on PyPI release with the XOS version, and what they publish is only built output and
 * documentation. The npm packages live under the owner's @ghxstship scope; @xos belongs to someone else.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packages = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(`${packages}${path}`, "utf8");

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly license: string;
  readonly files: readonly string[];
  readonly repository: { readonly url: string; readonly directory: string };
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly publishConfig: {
    readonly access: string;
    readonly provenance: boolean;
    readonly exports?: Readonly<Record<string, unknown>>;
  };
  readonly scripts: Readonly<Record<string, string>>;
}

const sdk = JSON.parse(read("sdk-ts/package.json")) as Manifest;
const cli = JSON.parse(read("cli/package.json")) as Manifest;
const pyproject = read("sdk-python/pyproject.toml");
const pyVersion = /^version = "([^"]+)"$/m.exec(pyproject)?.[1];
const pyInit = /^__version__ = "([^"]+)"$/m.exec(read("sdk-python/src/xos_sdk/__init__.py"))?.[1];
const cliVersion = /export const CLI_VERSION = "([^"]+)";/.exec(read("cli/src/cli.ts"))?.[1];

function targets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(targets);
  return [];
}

describe("release packages", () => {
  it("share one semantic version across npm, PyPI and the CLI banner", () => {
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect([cli.version, pyVersion, pyInit, cliVersion]).toEqual([
      sdk.version,
      sdk.version,
      sdk.version,
      sdk.version,
    ]);
  });

  it("are named in the owner's npm scope", () => {
    expect([sdk.name, cli.name]).toEqual(["@ghxstship/xos-sdk", "@ghxstship/xos-cli"]);
  });

  it("are publishable from this repository, without provenance while it is private", () => {
    for (const [manifest, dir] of [
      [sdk, "packages/sdk-ts"],
      [cli, "packages/cli"],
    ] as const) {
      expect(manifest.private).toBeUndefined();
      expect(manifest.license).toBe("MIT");
      // npm reads publishConfig from the packed tarball, so provenance here would make the publish job
      // ask Sigstore to sign a private repository's build, which it refuses (owner decision, 2026-10-24).
      expect(manifest.publishConfig).toMatchObject({ access: "public", provenance: false });
      expect(manifest.repository.url).toContain("github.com/ghxstship/atlas");
      expect(manifest.repository.directory).toBe(dir);
      expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"]);
      expect(manifest.scripts["prepack"]).toBe(manifest.scripts["build"]);
      expect(existsSync(`${packages}${dir.slice("packages/".length)}/README.md`)).toBe(true);
      expect(existsSync(`${packages}${dir.slice("packages/".length)}/LICENSE`)).toBe(true);
    }
    expect(pyproject).toContain('name = "xos-sdk"');
    expect(pyproject).toContain('readme = "README.md"');
    expect(pyproject).toContain('license = "MIT"');
    expect(existsSync(`${packages}sdk-python/README.md`)).toBe(true);
  });

  it("publish only built entry points, never the workspace-only codegen and test server", () => {
    const published = sdk.publishConfig.exports ?? {};
    expect(Object.keys(published).sort()).toEqual([".", "./package.json", "./webhooks"]);
    for (const target of targets(published).filter((t) => t !== "./package.json")) {
      expect(target).toMatch(/^\.\/dist\/.+\.(js|d\.ts)$/);
    }
    expect(cli.bin).toEqual({ xos: "./dist/main.js" });
    expect(read("cli/src/main.ts").startsWith("#!/usr/bin/env node\n")).toBe(true);
    // pnpm pack writes workspace:* as the exact SDK version; the publish job checks the packed manifest.
    expect(cli.dependencies?.["@ghxstship/xos-sdk"]).toBe("workspace:*");
  });
});
