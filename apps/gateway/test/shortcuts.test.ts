import { readFileSync } from "node:fs";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { describe, expect, it } from "vitest";

/**
 * Gateway's shortcuts come from the registry (packages/schemas/shortcuts.yaml): the help panel's sheet
 * reads it. Gateway answers the defaults without a key handler of its own (the frame listens for `?`,
 * the design system's CommandMenu for Mod+K), so a change to these defaults must change those too.
 */
describe("Gateway shortcuts", () => {
  it("are the keys the frame and the command menu answer", () => {
    const defaults = Object.fromEntries(
      SHORTCUT_REGISTRY.shells.gateway.shortcuts.map((s) => [s.id, s.keys]),
    );
    expect(defaults).toEqual({ "command-menu": "Mod+K", help: "?", close: "Escape" });
    const frame = readFileSync(
      new URL("../components/shell/gateway-frame.tsx", import.meta.url),
      "utf8",
    );
    expect(frame).toContain('event.key === "?"');
    expect(frame).toContain("<CommandMenu");
  });
});
