import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkgPath } from "./source.ts";

export interface TokenBuild {
  read(file: string): string;
  dispose(): void;
}

/** Runs build-tokens.mjs against a scratch copy of tokens/ so a test never depends on a prior build. */
export function buildTokens(): TokenBuild {
  const out = mkdtempSync(join(tmpdir(), "xos-tokens-"));
  cpSync(pkgPath("tokens"), join(out, "tokens"), { recursive: true });
  execFileSync(process.execPath, [pkgPath("build-tokens.mjs")], { cwd: out, stdio: "pipe" });
  return {
    read: (file) => readFileSync(join(out, "dist", file), "utf8"),
    dispose: () => rmSync(out, { recursive: true, force: true }),
  };
}

/** Custom properties declared in a CSS file. */
export function cssVars(css: string): string[] {
  return [...css.matchAll(/^\s*(--[\w-]+):/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** Every variable the build declares across base and all theme files. */
export function declaredVars(build: TokenBuild): Set<string> {
  const files = ["base", "theme.dark", "theme.light", "theme.sunlight"];
  return new Set(files.flatMap((f) => cssVars(build.read(`css/${f}.css`))));
}
