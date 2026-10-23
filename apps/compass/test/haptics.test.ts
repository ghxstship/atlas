import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  ImpactFeedbackStyle: { Medium: "medium" },
  selectionAsync: () => (calls.push("selection"), Promise.resolve()),
  notificationAsync: (type: string) => (calls.push(`notification:${type}`), Promise.resolve()),
  impactAsync: (style: string) => (calls.push(`impact:${style}`), Promise.resolve()),
}));

const { hapticCall, playHaptic } = await import("../src/runtime/haptics");

describe("ThemeProvider onHaptic on expo-haptics", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("maps every design-system haptic kind to an expo-haptics call", async () => {
    for (const kind of ["selection", "success", "warning", "impact"] as const)
      await hapticCall(kind)();
    expect(calls).toEqual([
      "selection",
      "notification:success",
      "notification:warning",
      "impact:medium",
    ]);
  });

  it("plays without waiting for the device", () => {
    playHaptic("impact");
    expect(calls).toEqual(["impact:medium"]);
  });
});

/**
 * Every haptic Compass plays follows the person's me.haptics (A65-001): the Haptics switch, the design system's
 * components and the screens that play their own. A screen that read the device switch alone kept vibrating after
 * the person turned Haptics off in Atlas or Gateway, and Compass's own Button played on every press whatever the
 * switch said.
 */
describe("every haptic follows me.haptics", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sources = ["app", "src"].flatMap((dir) =>
    (readdirSync(join(root, dir), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => [`${dir}/${f}`, readFileSync(join(root, dir, f), "utf8")] as const),
  );
  /** The one place expo-haptics plays for ThemeProvider, and the kiosk: the org's shared device, which no one's own me.haptics governs. */
  const UNGATED = ["src/runtime/haptics.ts", "app/kiosk.tsx"];

  it("reads the device switch only through hapticsOn, which prefers the resolved me.haptics", () => {
    expect(sources.length).toBeGreaterThan(50);
    for (const [file, source] of sources) {
      const reads = source.match(/(?<![.\w])settings\.haptics(?!\w)/g)?.length ?? 0;
      const gated = source.match(/hapticsOn\(\s*settings\.haptics(?!\w)/g)?.length ?? 0;
      expect(reads, file).toBe(gated);
    }
  });

  it("plays the design system's haptics through ThemeProvider, which gets a handler only while haptics are on", () => {
    const ui = sources.filter(([file]) => file.startsWith("src/ui/"));
    expect(ui.map(([file]) => file)).toContain("src/ui/primitives.tsx");
    for (const [file, source] of ui) {
      expect(source, file).not.toMatch(/from "expo-haptics"/);
    }
    const layout = sources.find(([file]) => file === "app/_layout.tsx")?.[1] ?? "";
    expect(layout).toMatch(
      /hapticsOn\(settings\.haptics, orgSettings\) \? \{ onHaptic: playHaptic \}/,
    );
  });

  it("gates every other expo-haptics call on hapticsOn", () => {
    const players = sources.filter(
      ([file, source]) => !UNGATED.includes(file) && source.includes('from "expo-haptics"'),
    );
    expect(players.map(([file]) => file).sort()).toEqual([
      "app/(tabs)/scan.tsx",
      "src/screens/ShowView.tsx",
    ]);
    for (const [file, source] of players) expect(source, file).toMatch(/hapticsOn\(/);
  });

  it("forgets the person's resolved values when they sign out", () => {
    const provider =
      sources.find(([file]) => file === "src/runtime/CompassProvider.tsx")?.[1] ?? "";
    // The auth listener's signed-out branch, local or remote: the next person never starts with them.
    expect(provider).toMatch(
      /if \(!next\) \{[^}]*setResolvedSettings\(NO_VALUES\);\s+void SecureStore\.deleteItemAsync\(RESOLVED_KEY\);/,
    );
  });
});
