import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { punchAnnouncementKey, queueAnnouncement, scanAnnouncement } from "../src/domain/announce";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function lookup(locale: (typeof locales)[number], key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages(locale),
    );
}

describe("A23-004: status messages are announced (WCAG 4.1.3)", () => {
  it("says what each punch did, or that it waits to upload", () => {
    expect(punchAnnouncementKey("In", true)).toBe("compass.announce.clockedIn");
    expect(punchAnnouncementKey("Break Start", true)).toBe("compass.announce.breakStarted");
    expect(punchAnnouncementKey("Break End", true)).toBe("compass.announce.breakEnded");
    expect(punchAnnouncementKey("Out", true)).toBe("compass.announce.clockedOut");
    expect(punchAnnouncementKey("In", false)).toBe("compass.clock.queued");
  });

  it("says queue count changes, never the first reading or an unchanged count", () => {
    expect(queueAnnouncement(null, 3)).toBeNull();
    expect(queueAnnouncement(2, 2)).toBeNull();
    expect(queueAnnouncement(0, 1)).toEqual({ key: "compass.sync.queuedOne", count: 1 });
    expect(queueAnnouncement(1, 4)).toEqual({ key: "compass.sync.queuedOther", count: 4 });
    expect(queueAnnouncement(4, 0)).toEqual({ key: "compass.sync.uploaded" });
  });

  it("speaks a scan result by its title, not the raw code", () => {
    expect(scanAnnouncement({ ok: true, title: "Asset RAD-001", code: "0123456789012" })).toBe(
      "Asset RAD-001",
    );
  });

  it.each(locales)("has every announcement in %s", (locale) => {
    for (const key of [
      "compass.announce.clockedIn",
      "compass.announce.breakStarted",
      "compass.announce.breakEnded",
      "compass.announce.clockedOut",
      "compass.clock.queued",
      "compass.sync.queuedOne",
      "compass.sync.queuedOther",
      "compass.sync.uploaded",
    ]) {
      expect(typeof lookup(locale, key), `${locale} ${key}`).toBe("string");
    }
  });

  it("announces scan results, punches, queue changes and toasts through ui-native's announce", () => {
    expect(read("../app/(tabs)/scan.tsx")).toMatch(/announce\(scanAnnouncement\(next\)\)/);
    expect(read("../app/(tabs)/today.tsx")).toMatch(/announce\(t\(punchAnnouncementKey\(/);
    expect(read("../src/screens/common.tsx")).toMatch(
      /queueAnnouncement\(previous\.current, queued\)/,
    );
    expect(read("../src/ui/layout.tsx")).toMatch(/useEffect\(\(\) => \{\s*announce\(message\);/);
    expect(read("../src/ui/index.ts")).toMatch(/export \{ announce,[^}]*\} from "@xos\/ui-native"/);
    // Android keeps the live region on the scan result.
    expect(read("../src/ui/compass.tsx")).toContain('accessibilityLiveRegion="polite"');
  });
});

describe("A23-005: the offline banner's action stays reachable (WCAG 4.1.2, 2.1.1)", () => {
  it("uses ui-native's OfflineBanner, whose count and View action are separate elements", () => {
    expect(read("../src/ui/index.ts")).toMatch(/OfflineBanner \} from "@xos\/ui-native"/);
    const layout = read("../src/ui/layout.tsx");
    expect(layout).not.toMatch(/export function OfflineBanner/);
    expect(layout).not.toMatch(/<View\s+accessible\b/);
  });
});
