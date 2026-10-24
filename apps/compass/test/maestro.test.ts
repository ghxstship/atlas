import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const root = new URL("..", import.meta.url).pathname;
const flowDir = join(root, ".maestro/flows");
const subflowDir = join(root, ".maestro/subflows");
/** Flows that need a helper beside Maestro (journey 57's push), run by their scripts/*.sh runner. */
const journeyDir = join(root, ".maestro/journeys");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [readFileSync(join(dir, e.name), "utf8")]
        : [],
  );
}

const code = [...sources(join(root, "app")), ...sources(join(root, "src"))].join("\n");

/** Test ids built at runtime from a prefix and a value (tabs, menu rows, options, keypad keys). */
const DYNAMIC = [
  "tab-",
  "more-",
  "scan-mode-",
  "settings-theme-",
  "kiosk-key-",
  "punch-",
  "project-",
  "template-",
  "incident-type-",
  "shift-",
  "batch-",
  "incident-voice-",
  "today-org-",
  "schedule-shift-",
  "expense-line-",
  "expense-aurora-",
  "external-",
  "settings-section-",
  "settings-privacy-section-",
];

function ids(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => ids(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "id" && typeof v === "string") out.push(v);
      else ids(v, out);
    }
  }
  return out;
}

const files = [
  ...readdirSync(flowDir).map((f) => join(flowDir, f)),
  ...readdirSync(subflowDir).map((f) => join(subflowDir, f)),
  ...readdirSync(journeyDir).map((f) => join(journeyDir, f)),
];

describe("Maestro flows", () => {
  it.each(files)("%s parses as a Maestro flow with an app id header", (file) => {
    const docs = parseAllDocuments(readFileSync(file, "utf8"));
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d.errors).toEqual([]);
    expect(docs[0]?.toJS()).toMatchObject({ appId: "pro.ghxstship.compass" });
    expect(Array.isArray(docs[1]?.toJS())).toBe(true);
  });

  it.each(files)("%s only targets test ids the app renders", (file) => {
    const steps = parseAllDocuments(readFileSync(file, "utf8"))[1]?.toJS() as unknown;
    // An id may be a Maestro regex of alternatives ("sign-in|tab-bar"); each one must exist.
    for (const id of ids(steps).flatMap((i) => i.split("|"))) {
      const literal = code.includes(`"${id}"`) || code.includes(`\`${id}\``);
      const dynamic = DYNAMIC.some(
        (p) => id.startsWith(p) && (code.includes(p) || code.includes(`"${p.slice(0, -1)}"`)),
      );
      const suffixed =
        /-(geofence|timer|count|done|last|nfc|confirm)$/.test(id) &&
        code.includes(`"${id.replace(/-[a-z]+$/, "")}"`);
      expect(literal || dynamic || suffixed, `${file}: ${id}`).toBe(true);
    }
  });

  // Maestro matches flowsOrder against each flow's name, not its file; a flow named otherwise drops the
  // whole order and the suite runs in any order (A66), so state-changing flows collide.
  it.each(readdirSync(flowDir))("%s is named after its file, so flowsOrder applies", (file) => {
    const header = parseAllDocuments(readFileSync(join(flowDir, file), "utf8"))[0]?.toJS() as {
      name?: string;
    };
    expect(header.name).toBe(file.replace(/\.yaml$/, ""));
  });

  it("orders every flow in config.yaml", () => {
    const config = parseAllDocuments(
      readFileSync(join(root, ".maestro/config.yaml"), "utf8"),
    )[0]?.toJS() as { executionOrder: { flowsOrder: string[] } };
    expect(config.executionOrder.flowsOrder.sort()).toEqual(
      readdirSync(flowDir)
        .map((f) => f.replace(/\.yaml$/, ""))
        .sort(),
    );
  });
});
