import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Compass's tests run in node and never render screens, so the layout is checked in its source, as the
// A23 checks do.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("A66: the keyboard never covers the field being typed into", () => {
  const layout = read("../src/ui/layout.tsx");
  const screen = layout.slice(
    layout.indexOf("export function Screen("),
    layout.indexOf("export function Card("),
  );

  it("shrinks a screen that fills the display above the keyboard (the scan tab's manual entry)", () => {
    expect(screen).toContain("<KeyboardAvoidingView");
    expect(screen).toContain('behavior={!scroll && Platform.OS === "ios" ? "padding" : undefined}');
    expect(screen).toContain("enabled={!scroll}");
    expect(read("../app/(tabs)/scan.tsx")).toMatch(/<Screen testID="scan"[^>]*scroll=\{false\}>/);
  });

  it("insets a scrolling screen and lets a button take a tap while the keyboard is up", () => {
    expect(screen).toMatch(
      /<ScrollView\s+automaticallyAdjustKeyboardInsets\s+keyboardShouldPersistTaps="handled"/,
    );
  });
});
