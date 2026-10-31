import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B3 (RRR-227, ADR 0142): the showcaller console works signed in and on a showcaller link's portal. Its writes go
 * through a transport (the show actions signed in, the portal's token actions outside), its keys come from the
 * person's bindings in the shell or from the shortcut registry's show-scope defaults on the portal. What the keys do
 * on a page, beside the show channel and a list, is show-keys-dom.test.ts.
 */
const actions = vi.hoisted(() => ({
  call: vi.fn(async () => ({ ok: true as const, data: null })),
  standby: vi.fn(async () => ({ ok: true as const, data: null })),
  shift: vi.fn(async () => ({ ok: true as const, data: null })),
}));
vi.mock("@/components/show/actions", () => ({
  callCueAction: actions.call,
  standbyCueAction: actions.standby,
  shiftCuePlanAction: actions.shift,
}));

const { consoleKeyAction, signedInTransport } =
  await import("@/components/show/showcaller-console");
const { defaultShowKeys } = await import("@/components/show/show-keys");

const keys = defaultShowKeys(SHORTCUT_REGISTRY.shells.atlas, "other");
const press = (chord: string, over: Partial<Parameters<typeof consoleKeyAction>[0]> = {}) =>
  consoleKeyAction({
    defaultPrevented: false,
    composing: false,
    repeat: false,
    jumping: false,
    inside: true,
    typing: false,
    chord,
    scoped: keys,
    singleKeys: true,
    ...over,
  });

describe("the portal's keys", () => {
  it("come from the registry's show scope, the show channel's M among them", () => {
    expect(keys).toMatchObject({
      "show.go": "Space",
      "show.next": "J",
      "show.standby": "S",
      "show.chat": "M",
      "show.deck.go": "F13",
    });
  });

  it("make console actions inside the console", () => {
    expect(press("S")).toBe("standby");
    expect(press("J")).toBe("next");
    expect(press("F13")).toBe("go");
    // Space stays with the cue list, so one press makes one call; M hands focus to the show channel.
    expect(press("Space")).toBeNull();
    expect(press("M")).toBe("chat");
  });

  it("answer nothing typed in a field or pressed outside the console", () => {
    for (const chord of ["S", "J", "M"]) {
      expect(press(chord, { typing: true }), chord).toBeNull();
      expect(press(chord, { inside: false }), chord).toBeNull();
    }
  });

  it("keep F13 to F20 with character keys turned off", () => {
    expect(press("S", { singleKeys: false })).toBeNull();
    expect(press("F14", { singleKeys: false })).toBe("standby");
  });

  it("do nothing while Jump to cue is open, repeating or composing", () => {
    expect(press("S", { jumping: true })).toBeNull();
    expect(press("S", { repeat: true })).toBeNull();
    expect(press("S", { composing: true })).toBeNull();
  });
});

describe("the signed-in transport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls, stands by and nudges through the show actions", async () => {
    const transport = signedInTransport("northwind-live", "run-1");
    await transport.call("cue-1");
    await transport.standby(null);
    await transport.nudge(60);
    expect(actions.call).toHaveBeenCalledWith("northwind-live", "cue-1");
    expect(actions.standby).toHaveBeenCalledWith("northwind-live", "run-1", null);
    expect(actions.shift).toHaveBeenCalledWith("northwind-live", "run-1", 60);
  });
});
