import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Compass's tests run in node and never render screens, so the layout is checked in its source, as the
// A23 checks do.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("A66: the keyboard never covers the scan tab's code entry", () => {
  it("puts the code entry above the access points and the camera", () => {
    const scan = read("../app/(tabs)/scan.tsx");
    const live = scan.slice(scan.indexOf("function LiveScan("));
    expect(live.indexOf("<ManualEntry")).toBeGreaterThan(0);
    expect(live.indexOf("<ManualEntry")).toBeLessThan(live.indexOf('testID="scan-zone"'));
    expect(live.indexOf("<ManualEntry")).toBeLessThan(live.indexOf("<ScanSheet"));
  });

  it("keeps Screen free of keyboard avoidance, which lost typed characters in multiline fields", () => {
    // A66 tried a KeyboardAvoidingView around every screen (and keyboard insets on its ScrollView): on the
    // simulator an inspection's multiline fail note then kept only the first character typed.
    const layout = read("../src/ui/layout.tsx");
    const screen = layout.slice(
      layout.indexOf("export function Screen("),
      layout.indexOf("export function Card("),
    );
    expect(screen).not.toContain("KeyboardAvoidingView");
    expect(screen).not.toContain("automaticallyAdjustKeyboardInsets");
  });
});
