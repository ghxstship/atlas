import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { countdownAnnouncement, countdownParts } from "../src/domain/show";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function lookup(locale: (typeof locales)[number], key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages(locale),
    );
}

describe("A23-006: radios report checked (WCAG 4.1.2)", () => {
  it("uses checked, not selected, on segmented options and incident types", () => {
    expect(read("../src/ui/primitives.tsx")).toContain(
      "accessibilityState={{ checked: selected }}",
    );
    const compass = read("../src/ui/compass.tsx");
    expect(compass).toContain("accessibilityState={{ checked: isSelected }}");
    expect(compass).not.toMatch(/accessibilityRole="radio"\s+accessibilityState=\{\{ selected/);
  });

  it("names the incident type grid as a radio group", () => {
    expect(read("../src/ui/compass.tsx")).toMatch(
      /accessibilityRole="radiogroup"\s+accessibilityLabel=\{labels\.typeGroup/,
    );
    expect(read("../app/incidents/new.tsx")).toContain('t("compass.incidents.typeGroup")');
  });
});

describe("A23-007: the clock button scales text to 200 percent (WCAG 1.4.4)", () => {
  it("caps no Compass text below a multiplier of 2", () => {
    for (const file of [
      "../src/ui/compass.tsx",
      "../src/ui/primitives.tsx",
      "../src/ui/layout.tsx",
    ]) {
      expect(read(file), file).not.toMatch(/maxFontSizeMultiplier=\{1(\.\d+)?\}/);
    }
  });
});

describe("A23-008: Reduce Motion is honored", () => {
  it("fades sheets and counts the hold down instead of animating", () => {
    const layout = read("../src/ui/layout.tsx");
    expect(layout).toContain("const still = useReducedMotion();");
    expect(layout).toContain('animationType={still ? "fade" : "slide"}');
    const primitives = read("../src/ui/primitives.tsx");
    expect(primitives).toContain("const still = useReducedMotion();");
    expect(primitives).toContain("{holdToConfirm && !still ? (");
  });
});

describe("A23-009: the countdown is spoken at set points (WCAG 4.1.3, 2.2.2)", () => {
  it("speaks once as the countdown crosses 60, 30 and 10 seconds and the cue", () => {
    expect(countdownAnnouncement(null, 59_000)).toBeNull();
    expect(countdownAnnouncement(61_000, 60_500)).toBeNull();
    expect(countdownAnnouncement(60_500, 60_000)).toBe(60);
    expect(countdownAnnouncement(45_000, 44_500)).toBeNull();
    expect(countdownAnnouncement(30_400, 29_900)).toBe(30);
    expect(countdownAnnouncement(10_200, 9_700)).toBe(10);
    expect(countdownAnnouncement(300, -200)).toBe(0);
    expect(countdownAnnouncement(-200, -700)).toBeNull();
    // A long gap between ticks speaks the nearest point only.
    expect(countdownAnnouncement(65_000, 8_000)).toBe(10);
  });

  it("splits the countdown into whole minutes and seconds for the spoken label", () => {
    expect(countdownParts(130_400)).toEqual({ late: false, minutes: 2, seconds: 10 });
    expect(countdownParts(-5_000)).toEqual({ late: true, minutes: 0, seconds: 5 });
  });

  it("keeps the countdown out of the live region and announces from the screen", () => {
    const compass = read("../src/ui/compass.tsx");
    expect(compass).toMatch(
      /accessibilityLiveRegion="polite">\s*<Text variant="label13" tone="accent">\s*\{nextLabel\}\s*<\/Text>\s*<Text variant=\{big\} testID="next-cue-title">\s*\{next\.title\}\s*<\/Text>\s*<\/View>/,
    );
    expect(compass).toContain("accessibilityLabel={countdownLabel ?? countdown}");
    expect(read("../src/screens/ShowView.tsx")).toMatch(/countdownAnnouncement\(previous\.current/);
  });
});

describe("A23-010: kiosk PIN progress and banner dismiss labels (WCAG 1.1.1, 4.1.2)", () => {
  it("reads the PIN as a count of digits", () => {
    expect(read("../app/kiosk.tsx")).toContain('countKey("compass.kiosk.pinProgress", digits)');
  });

  it("never renders an unnamed dismiss button", () => {
    expect(read("../src/ui/layout.tsx")).not.toContain('dismissLabel ?? ""');
    expect(read("../../../packages/ui-native/src/types.ts")).toContain(
      "| { onDismiss: () => void; dismissLabel: string }",
    );
  });
});

describe("A23 Compass copy", () => {
  it.each(locales)("has every new message in %s", (locale) => {
    for (const key of [
      "compass.incidents.typeGroup",
      "compass.kiosk.pinProgressOne",
      "compass.kiosk.pinProgressOther",
      "compass.show.countdownLabel",
      "compass.show.countdownLate",
      "compass.show.countdownSoon",
      "compass.show.countdownGo",
    ]) {
      expect(typeof lookup(locale, key), `${locale} ${key}`).toBe("string");
    }
  });
});
