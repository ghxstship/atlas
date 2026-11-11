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

// The Workforce Suite screens Compass mounts (app/workforce) render from @xos/workforce-native, so their ids count.
const code = [
  ...sources(join(root, "app")),
  ...sources(join(root, "src")),
  ...sources(join(root, "../../packages/workforce-native/src")),
].join("\n");

/** Test ids built at runtime from a prefix and a value (tabs, menu rows, options, keypad keys). */
const DYNAMIC = [
  "crew-no-show-",
  "tab-",
  "more-",
  "scan-mode-",
  "settings-theme-",
  "kiosk-key-",
  "punch-",
  "project-",
  "template-",
  // B7's feed contents: one switch per source.
  "settings-feeds-source-",
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
  // A111's settings: a registered setting by key, a notification cell by category and channel, a Work Details field.
  "setting-",
  "notify-",
  "work-",
  // A126's Today search: a group by kind, a result by kind and row.
  "search-group-",
  "search-result-",
  // R7a's Receive against an order sheet: an order by number, a line's stepper by line number.
  "receive-order-",
  "receive-more-",
  // A140: a sponsor's proof photo button, by entitlement.
  "proof-photo-",
  // P2's department picker: one option per app.cue_call_kind slug, and All (SegmentedControl testID-value).
  "show-department-",
  // B11's gate view: a booking's card and its actions, by dock slot.
  "gate-booking-",
  "gate-arrived-",
  "gate-release-",
  "gate-check-in-",
  // A feed's source choices: one per calendar source.
  "settings-feeds-source-",
  // A141's component gallery: a page by its number.
  "gallery-page-",
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

function tagsOf(file: string): string[] {
  const header = parseAllDocuments(readFileSync(join(flowDir, file), "utf8"))[0]?.toJS() as {
    tags?: string[];
  };
  return header.tags ?? [];
}

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

  it("orders every flow of the suite in config.yaml and leaves the gallery flows out of it", () => {
    const config = parseAllDocuments(
      readFileSync(join(root, ".maestro/config.yaml"), "utf8"),
    )[0]?.toJS() as { excludeTags: string[]; executionOrder: { flowsOrder: string[] } };
    expect(config.excludeTags).toEqual(["gallery"]);
    const suite = readdirSync(flowDir).filter((f) => !tagsOf(f).includes("gallery"));
    expect(config.executionOrder.flowsOrder.sort()).toEqual(
      suite.map((f) => f.replace(/\.yaml$/, "")).sort(),
    );
  });

  // A141: gallery-*.yaml need a gallery build (EXPO_PUBLIC_XOS_GALLERY=1), which the suite's release build is not.
  it("tags every gallery flow, and only those, gallery", () => {
    for (const file of readdirSync(flowDir)) {
      expect(tagsOf(file).includes("gallery"), file).toBe(file.startsWith("gallery-"));
    }
    expect(
      readdirSync(flowDir)
        .filter((f) => f.startsWith("gallery-"))
        .sort(),
    ).toEqual(["gallery-dark.yaml", "gallery-light.yaml"]);
  });
});
