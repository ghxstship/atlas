import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_NAMESPACES } from "@/i18n/request";

/**
 * The next-intl client provider carries only CLIENT_NAMESPACES (A24-009). A client component that
 * reads another namespace would render raw keys, so every literal namespace and every literal root
 * key in a "use client" file must fall inside the list.
 */
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "e2e", "test"]);

function clientFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return clientFiles(path);
    if (!/\.tsx?$/.test(name)) return [];
    return readFileSync(path, "utf8").startsWith('"use client"') ? [path] : [];
  });
}

describe("client namespaces", () => {
  const files = clientFiles(appRoot);

  it("finds the client components", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("covers every namespace a client component asks for", () => {
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/useTranslations\(\s*["'`]([a-zA-Z]+)/g)) {
        const ns = match[1] ?? "";
        if (!(CLIENT_NAMESPACES as readonly string[]).includes(ns)) {
          missing.push(`${file.slice(appRoot.length)}: ${ns}`);
        }
      }
      for (const match of source.matchAll(/errorsNamespace="([a-zA-Z]+)/g)) {
        const ns = match[1] ?? "";
        if (!(CLIENT_NAMESPACES as readonly string[]).includes(ns)) {
          missing.push(`${file.slice(appRoot.length)}: ${ns}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
