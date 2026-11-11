import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_MORE } from "../src/domain/access";
import { MORE_ICONS, moreIcon } from "../src/domain/moreIcons";

const registry = readFileSync(
  fileURLToPath(new URL("../../../packages/ui-native/src/icons.generated.ts", import.meta.url)),
  "utf8",
);
const pascal = (name: string) =>
  name.replace(/(^|-)([a-z0-9])/g, (_m, _d: string, c: string) => c.toUpperCase());

describe("C-21: every More row has its own icon", () => {
  it("names an icon for every entry Compass renders, Drives among them", () => {
    for (const id of NATIVE_MORE) expect(MORE_ICONS[id], id).toBeDefined();
    expect(moreIcon("drives")).toBe("navigation");
  });

  it("names only icons the native registry draws", () => {
    for (const icon of new Set(Object.values(MORE_ICONS))) {
      expect(registry, icon).toContain(`  ${pascal(icon)}: Lucide`);
    }
  });

  it("never puts a chevron in the icon slot", () => {
    expect(moreIcon("not-yet-mapped")).toBe("file-text");
    expect(Object.values(MORE_ICONS)).not.toContain("chevron-right");
  });
});
