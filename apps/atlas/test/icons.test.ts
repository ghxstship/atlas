import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIcon } from "@xos/icons";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("icons Atlas draws by name", () => {
  it("are all in the @xos/icons registry, so none renders as a blank box", () => {
    const missing: string[] = [];
    for (const file of [...sources(join(app, "app")), ...sources(join(app, "components"))]) {
      for (const match of readFileSync(file, "utf8").matchAll(/icon[=:]\s*\{?"([A-Z]\w+)"/g)) {
        const name = match[1] as string;
        if (resolveIcon(name) === null) missing.push(`${name} (${file.slice(app.length)})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
