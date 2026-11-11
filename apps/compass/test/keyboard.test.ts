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

  it("lets Delete Account take its hold straight after the email is typed (A68, journey 38)", () => {
    const layout = read("../src/ui/layout.tsx");
    expect(layout).toContain(
      "{...(keyboardShouldPersistTaps ? { keyboardShouldPersistTaps } : {})}",
    );
    const deleteAccount = read("../src/screens/DeleteAccount.tsx");
    expect(deleteAccount).toMatch(
      /<Screen\s+testID="account"\s+title=\{t\("compass\.account\.title"\)\}\s+keyboardShouldPersistTaps="handled"/,
    );
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

describe("C-06: the Workforce screens sit below the native header", () => {
  it("tells @xos/ui-native's Screen about the root stack's header, as Compass's own Screen is told", () => {
    const layout = read("../src/ui/layout.tsx");
    const provider = layout.slice(layout.indexOf("export function NativeHeaderProvider("));
    expect(provider).toContain(
      "<NativeScreenHeaderContext.Provider value={value ? STACK_HEADER : null}>",
    );
    expect(layout).toContain("title: (title) => <Stack.Screen options={{ title }} />");
    expect(read("../app/_layout.tsx")).toContain("<NativeHeaderProvider value={true}>");
    for (const path of ["../app/(tabs)/_layout.tsx", "../app/kiosk.tsx"]) {
      expect(read(path)).toContain("<NativeHeaderProvider value={false}>");
    }
    for (const path of ["../app/_layout.tsx", "../app/(tabs)/_layout.tsx", "../app/kiosk.tsx"]) {
      expect(read(path)).not.toContain("NativeHeaderContext.Provider");
    }
  });
});

describe("Today search answers the first tap", () => {
  it("opens a result while the keyboard is up (C-15)", () => {
    const today = read("../app/(tabs)/today.tsx");
    const main = today.slice(today.lastIndexOf("<Screen"));
    expect(main).toMatch(/<Screen\s+testID="today"[^>]*keyboardShouldPersistTaps="handled"/);
    expect(main.indexOf("<TodaySearch />")).toBeGreaterThan(0);
  });

  it("makes the search field itself at least the minimum touch height (C-25)", () => {
    const search = read("../src/screens/TodaySearch.tsx");
    const input = search.slice(
      search.indexOf('testID="today-search"'),
      search.indexOf("/>", search.indexOf('testID="today-search"')),
    );
    expect(input).toContain("minHeight: theme.density.touchMin");
  });
});
