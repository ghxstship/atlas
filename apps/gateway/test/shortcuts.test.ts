import { readFileSync } from "node:fs";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { describe, expect, it } from "vitest";

/**
 * Gateway's shortcuts come from the registry (packages/schemas/shortcuts.yaml): the help panel's sheet
 * reads it. Gateway's frame answers the defaults itself (`?` for help, Mod+K for the command menu), so a
 * change to these defaults must change the frame too.
 */
describe("Gateway shortcuts", () => {
  it("are the keys the frame answers", () => {
    const defaults = Object.fromEntries(
      SHORTCUT_REGISTRY.shells.gateway.shortcuts.map((s) => [s.id, s.keys]),
    );
    expect(defaults).toEqual({ "command-menu": "Mod+K", help: "?", close: "Escape" });
    const frame = readFileSync(
      new URL("../components/shell/gateway-frame.tsx", import.meta.url),
      "utf8",
    );
    expect(frame).toContain('event.key === "?"');
    expect(frame).toContain('event.key.toLowerCase() === "k"');
  });
});
