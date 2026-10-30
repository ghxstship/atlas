/**
 * Route view transitions (Section 11.7, ADR 0118). Next remounts a template only when the segment
 * right below it changes, so every directory under app/(shell) that holds a page one level down or
 * deeper has a template.tsx rendering RouteTransition: then every change of path inside the shell
 * remounts one, and the page fades. The templates are server components that only re-export
 * RouteTransition, so they add no route JavaScript.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("../app/", import.meta.url));
const shell = join(app, "(shell)");
const TEMPLATE = 'export { RouteTransition as default } from "@xos/ui/route-transition";';

function directories(dir: string): string[] {
  return [
    dir,
    ...readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isDirectory())
      .flatMap(directories),
  ];
}

const hasPage = (dir: string) => existsSync(join(dir, "page.tsx"));
const all = directories(shell);
/** Directories with a page in a directory below them, where a change of path below remounts a template. */
const parents = all.filter((dir) => all.some((d) => d.startsWith(`${dir}/`) && hasPage(d)));

describe("route view transitions", () => {
  it("finds the shell's sections", () => {
    expect(parents.map((d) => relative(app, d))).toEqual(
      expect.arrayContaining([
        "(shell)",
        "(shell)/work/engagements/[engagementKey]",
        "(shell)/settings",
      ]),
    );
  });

  it("gives every directory with pages below it a template that renders RouteTransition", () => {
    const missing = parents
      .filter((dir) => {
        const file = join(dir, "template.tsx");
        return !existsSync(file) || !readFileSync(file, "utf8").includes(TEMPLATE);
      })
      .map((dir) => relative(app, dir));
    expect(missing).toEqual([]);
  });

  it("keeps templates where they remount something, and nowhere they would hold client code", () => {
    const stray = all
      .filter((dir) => existsSync(join(dir, "template.tsx")) && !parents.includes(dir))
      .map((dir) => relative(app, dir));
    expect(stray).toEqual([]);
    for (const dir of parents) {
      expect(readFileSync(join(dir, "template.tsx"), "utf8"), relative(app, dir)).not.toContain(
        "use client",
      );
    }
  });
});
