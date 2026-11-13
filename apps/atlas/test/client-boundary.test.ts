import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A server module never calls a plain function exported by a "use client" module (crawl 4.9): on the server such an
 * export is a client reference, and calling it throws "Attempted to call errorMessage() from the server", so the
 * page answers 500. Components (capitalized) and hooks may be imported to render; functions such as errorMessage
 * live in server-safe modules (components/auth/error-message.ts).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== ".next") sources(path, out);
    } else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/** Each lowercase, non-hook name a server module imports from a client module, as "file: name from module". */
function serverCallsIntoClient(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (CLIENT.test(src)) continue;
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
      if (m[1] || !m[2] || !m[3]) continue;
      const target = resolveImport(file, m[3]);
      if (!target || !CLIENT.test(readFileSync(target, "utf8"))) continue;
      const names = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "" && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0]?.trim() ?? "");
      for (const name of names) {
        if (/^[a-z]/.test(name) && !/^use[A-Z]/.test(name)) {
          found.push(`${relative(ROOT, file)}: ${name} from ${m[3]}`);
        }
      }
    }
  }
  return found;
}

describe("the client boundary", () => {
  it("no server module imports a plain function from a 'use client' module", () => {
    const files = ["app", "components", "lib"].flatMap((d) => sources(join(ROOT, d)));
    expect(serverCallsIntoClient(files)).toEqual([]);
  });

  it("the invitation page reads its refusal copy from the server-safe module", () => {
    const page = readFileSync(join(ROOT, "app/auth/invite/[token]/page.tsx"), "utf8");
    expect(page).toContain('from "@/components/auth/error-message"');
    const shared = readFileSync(join(ROOT, "components/auth/error-message.ts"), "utf8");
    expect(CLIENT.test(shared)).toBe(false);
  });
});
