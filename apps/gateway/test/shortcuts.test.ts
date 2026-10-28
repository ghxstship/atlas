import { readFileSync } from "node:fs";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { describe, expect, it } from "vitest";
import { buildGatewayKeys } from "../lib/shell/shell-keys";

/**
 * Gateway's shortcuts come from the registry (packages/schemas/shortcuts.yaml): the help panel's sheet
 * reads it. Gateway's frame answers search, help and Esc itself (`?` for help, Mod+K for the command
 * menu), so a change to these defaults must change the frame too; the letter keys reach the frame from
 * the server (lib/shell/shell-keys.ts), so they follow the registry by construction.
 */
describe("Gateway shortcuts", () => {
  it("are the keys the frame answers", () => {
    const defaults = Object.fromEntries(
      SHORTCUT_REGISTRY.shells.gateway.shortcuts.map((s) => [s.id, s.keys]),
    );
    expect(defaults).toMatchObject({ "command-menu": "Mod+K", help: "?", close: "Escape" });
    const frame = readFileSync(
      new URL("../components/shell/gateway-frame.tsx", import.meta.url),
      "utf8",
    );
    expect(frame).toContain('event.key === "?"');
    expect(frame).toContain('event.key.toLowerCase() === "k"');
    // Every other default is a letter or G then a letter, which the frame's letter handler answers.
    const own = new Set(["command-menu", "help", "close", "undo", "redo"]);
    for (const s of SHORTCUT_REGISTRY.shells.gateway.shortcuts) {
      if (own.has(s.id)) continue;
      expect(s.keys, s.id).toMatch(s.go === null ? /^[A-Z]$/ : /^[A-Z] [A-Z]$/);
    }
  });

  it("go only where the person's navigation goes, and offer Switch org only where it exists", () => {
    const hrefs = new Map([
      ["home", "/home"],
      ["work", "/work"],
      ["settings", "/settings"],
    ]);
    const keys = buildGatewayKeys(SHORTCUT_REGISTRY, hrefs, new Set(["account"]));
    expect(keys.go).toEqual({ "G H": "/home", "G W": "/work", "G T": "/settings" });
    expect(keys.commands).toEqual({ A: "account" });
    expect(keys.shown).toEqual([
      "command-menu",
      "help",
      "account",
      "go.home",
      "go.work",
      "go.settings",
      "close",
    ]);
    const platform = buildGatewayKeys(SHORTCUT_REGISTRY, hrefs, new Set(["account", "switch-org"]));
    expect(platform.commands).toEqual({ A: "account", O: "switch-org" });
    expect(platform.shown).toContain("switch-org");
  });
});
