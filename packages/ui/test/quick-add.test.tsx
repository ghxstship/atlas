import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  QuickAdd,
  XOSProvider,
  finalizeQuickAdd,
  parseQuickAdd,
  quickAddKey,
  zonedInstant,
  type QuickAddResolution,
  type QuickAddResolver,
} from "../src/index.ts";
import { zoneOffsetMinutes } from "../src/Editing/quickAddCore.ts";
import { expectAccessible } from "./a11y.ts";

// Monday 2026-10-05, 9:00 in New York.
const monday = new Date("2026-10-05T13:00:00Z");
const ny = { referenceDate: monday, timeZone: "America/New_York" };

const kinds = (text: string, options = ny) =>
  parseQuickAdd(text, options).tokens.map((t) => [t.type, t.value]);

describe("parseQuickAdd in en-US", () => {
  it("reads the five token types and a date phrase with its time", () => {
    const parsed = parseQuickAdd("Hang truss @dana #rigging /Task ~stage-a Friday 8am", ny);
    expect(parsed.title).toBe("Hang truss");
    expect(parsed.tokens.map((t) => t.type)).toEqual(["person", "tag", "kind", "scope", "date"]);
    expect(parsed.tokens.at(-1)).toMatchObject({
      value: "Friday 8am",
      iso: "2026-10-09",
      time: "08:00",
    });
  });

  it("leaves the time out for a day alone, and reads ranges and overnight ranges", () => {
    expect(parseQuickAdd("Advance call next Friday", ny).tokens[0]).toMatchObject({
      iso: "2026-10-16",
    });
    expect(parseQuickAdd("Advance call next Friday", ny).tokens[0]?.time).toBeUndefined();
    expect(parseQuickAdd("Stagehand Fri 8am-4pm", ny).tokens[0]).toMatchObject({
      iso: "2026-10-09",
      time: "08:00",
      endIso: "2026-10-09",
      endTime: "16:00",
    });
    expect(parseQuickAdd("Night watch Fri 10pm-6am", ny).tokens[0]).toMatchObject({
      iso: "2026-10-09",
      time: "22:00",
      endIso: "2026-10-10",
      endTime: "06:00",
    });
  });

  it("reads the day after tomorrow, which chrono reads as tomorrow", () => {
    const parsed = parseQuickAdd("Strike day after tomorrow", ny);
    expect(parsed.title).toBe("Strike");
    expect(parsed.tokens[0]).toMatchObject({ value: "day after tomorrow", iso: "2026-10-07" });
  });

  it("drops the word that only joins the date to the title", () => {
    expect(parseQuickAdd("Hang truss by Friday", ny).title).toBe("Hang truss");
    expect(parseQuickAdd("Dock 2 at noon", ny).tokens[0]).toMatchObject({ time: "12:00" });
    expect(parseQuickAdd("Dock 2 at noon", ny).title).toBe("Dock 2");
  });
});

describe("parseQuickAdd in es-US", () => {
  const es = { ...ny, locale: "es-US" };

  it("reads Spanish date phrases with chrono's Spanish parser", () => {
    const parsed = parseQuickAdd("Colgar truss @dana viernes 8am", es);
    expect(parsed.title).toBe("Colgar truss");
    expect(parsed.tokens[1]).toMatchObject({ iso: "2026-10-09", time: "08:00" });
    expect(parseQuickAdd("Prueba mañana a las 15:00", es).tokens[0]).toMatchObject({
      iso: "2026-10-06",
      time: "15:00",
    });
    expect(parseQuickAdd("Llamada el viernes a las 8", es).title).toBe("Llamada");
    expect(parseQuickAdd("Turno vie 8am-4pm", es).tokens[0]).toMatchObject({
      endTime: "16:00",
    });
  });

  it("reads pasado mañana as two days on, and numeric dates day first", () => {
    expect(parseQuickAdd("Prueba pasado mañana a las 9", es).tokens[0]).toMatchObject({
      value: "pasado mañana a las 9",
      iso: "2026-10-07",
      time: "09:00",
    });
    expect(parseQuickAdd("Reunión 24/10", es).tokens[0]).toMatchObject({ iso: "2026-10-24" });
    expect(parseQuickAdd("Reunión 10/24", es).tokens).toEqual([]);
  });

  it("does not read English phrases as Spanish dates", () => {
    expect(parseQuickAdd("Hang truss Friday", es).tokens).toEqual([]);
  });
});

describe("parseQuickAdd time zones", () => {
  // 02:30 UTC on Tuesday is still Monday evening in Los Angeles.
  const late = new Date("2026-10-06T02:30:00Z");

  it("counts relative days on the zone's calendar", () => {
    const tomorrow = (timeZone: string) =>
      parseQuickAdd("Load test tomorrow", { referenceDate: late, timeZone }).tokens[0]?.iso;
    expect(tomorrow("America/Los_Angeles")).toBe("2026-10-06");
    expect(tomorrow("UTC")).toBe("2026-10-07");
    expect(tomorrow("Asia/Tokyo")).toBe("2026-10-07");
  });

  it("reads a phrase that names its own zone on the line's zone", () => {
    const parsed = parseQuickAdd("Call Sat 9pm EST", {
      referenceDate: monday,
      timeZone: "America/Los_Angeles",
    });
    // chrono reads EST as UTC-5 all year: 02:00 UTC on Sunday, 19:00 on Saturday in Los Angeles.
    expect(parsed.tokens[0]).toMatchObject({ iso: "2026-10-10", time: "19:00" });
  });

  it("turns a wall clock into an instant in a zone, daylight saving included", () => {
    expect(zonedInstant("2026-10-09", "08:00", "America/New_York")).toBe(
      "2026-10-09T12:00:00.000Z",
    );
    expect(zonedInstant("2026-12-09", "08:00", "America/New_York")).toBe(
      "2026-12-09T13:00:00.000Z",
    );
    // 2:30 does not exist on the spring-forward night; it reads as the hour after.
    expect(zonedInstant("2026-03-08", "02:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(zoneOffsetMinutes(monday, "Asia/Kolkata")).toBe(330);
  });
});

describe("parseQuickAdd ambiguous tokens", () => {
  it("reads a sigil only at the start of a word", () => {
    expect(kinds("Email dana@example.com and/or w/crew")).toEqual([]);
    expect(kinds("Fix bolt #2 on truss")).toEqual([]);
    expect(kinds("Fix #5000.51.02 rig ~NWS-S01")).toEqual([
      ["tag", "5000.51.02"],
      ["scope", "NWS-S01"],
    ]);
  });

  it("leaves trailing punctuation in the title", () => {
    const parsed = parseQuickAdd("Call @dana, then confirm", ny);
    expect(parsed.tokens[0]?.value).toBe("dana");
    expect(parsed.title).toBe("Call, then confirm");
  });

  it("sets one of each type; a second stays text", () => {
    const parsed = parseQuickAdd("Pair @dana @lee Friday Monday", ny);
    expect(parsed.tokens.map((t) => t.value)).toEqual(["dana", "Friday"]);
    expect(parsed.title).toBe("Pair @lee Monday");
  });

  it("never reads a token as a date, nor a short word that is also a word", () => {
    expect(kinds("Cue ~friday")).toEqual([["scope", "friday"]]);
    expect(kinds("Sun stage wash")).toEqual([]);
    expect(kinds("Call May about rigging")).toEqual([]);
    expect(kinds("Sun 8am stage wash")).toEqual([["date", "Sun 8am"]]);
    expect(kinds("Limpiar mar", { ...ny, locale: "es-US" } as typeof ny)).toEqual([]);
  });

  it("reads numeric dates in the locale's order and leaves 24/7 alone", () => {
    expect(kinds("Ops 24/7 desk")).toEqual([]);
    expect(kinds("Meeting 24/10")).toEqual([]);
    expect(parseQuickAdd("Meeting 10/24", ny).tokens[0]).toMatchObject({ iso: "2026-10-24" });
  });

  it("keeps dismissed tokens as text", () => {
    const parsed = parseQuickAdd("Rig @dana Friday", {
      ...ny,
      dismissed: [quickAddKey({ type: "date", value: "Friday" }), "person:dana"],
    });
    expect(parsed.tokens).toEqual([]);
    expect(parsed.title).toBe("Rig @dana Friday");
  });
});

describe("finalizeQuickAdd", () => {
  const parsed = parseQuickAdd("Hang @zed truss @dan ~open /task Friday", ny);

  it("applies every token without resolutions", () => {
    // The second person stays text; the first, with no resolver, applies.
    expect(finalizeQuickAdd(parsed).title).toBe("Hang truss @dan");
  });

  it("applies resolved and chosen tokens and leaves the rest where they were typed", () => {
    const parse = parseQuickAdd("Hang @zed truss ~open /task Friday", ny);
    const resolutions: Record<string, QuickAddResolution> = {
      "person:zed": { status: "unresolved" },
      "scope:open": {
        status: "ambiguous",
        candidates: [
          { id: "s1", label: "Opening Night" },
          { id: "s2", label: "Open Air Stage" },
        ],
      },
      "kind:task": { status: "resolved", id: "Task", label: "Task" },
    };
    const unchosen = finalizeQuickAdd(parse, resolutions);
    expect(unchosen.title).toBe("Hang @zed truss ~open");
    expect(unchosen.tokens.map((t) => [t.type, t.id])).toEqual([
      ["kind", "Task"],
      ["date", undefined],
    ]);
    const chosen = finalizeQuickAdd(parse, resolutions, { "scope:open": "s2" });
    expect(chosen.title).toBe("Hang @zed truss");
    expect(chosen.tokens[0]).toMatchObject({ type: "scope", id: "s2", label: "Open Air Stage" });
  });
});

/** A resolver over a fixed directory, recording each call. */
function directory(): QuickAddResolver & { calls: string[][] } {
  const answers: Record<string, QuickAddResolution> = {
    "person:dan": { status: "resolved", id: "p1", label: "Dana Kim" },
    "kind:task": { status: "resolved", id: "Task", label: "Task" },
    "scope:open": {
      status: "ambiguous",
      candidates: [
        { id: "s1", label: "Opening Night", detail: "NWS" },
        { id: "s2", label: "Open Air Stage", detail: "HBR" },
      ],
    },
  };
  const calls: string[][] = [];
  const resolve = vi.fn(async (tokens: readonly { type: string; value: string }[]) => {
    calls.push(tokens.map((t) => `${t.type}:${t.value}`));
    return Object.fromEntries(
      tokens.flatMap((t) => {
        const key = quickAddKey(t as Parameters<typeof quickAddKey>[0]);
        return answers[key] ? [[key, answers[key]]] : [];
      }),
    );
  });
  return Object.assign(resolve, { calls }) as QuickAddResolver & { calls: string[][] };
}

describe("QuickAdd with a resolver", () => {
  it("shows resolved chips, keeps unresolved tokens as text and offers a choice", async () => {
    const resolve = directory();
    const onSubmit = vi.fn();
    const { container } = render(
      <QuickAdd
        label="Quick add a record"
        referenceDate={monday}
        timeZone="America/New_York"
        resolve={resolve}
        labels={{ person: "Owner", tag: "Category", kind: "Kind", scope: "Scope", date: "When" }}
        copy={{
          field: (name, value) => `${name}: ${value}`,
          announce: (title, fields) => `${title}, with ${fields}`,
          choose: (token) => `Choose a match for ${token}`,
          matches: (count) => `Matches: ${count}`,
        }}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Quick add a record" });
    await userEvent.type(input, "Hang truss @dan #zz ~open /task Friday 8am");
    await screen.findByText("Dana Kim");
    // #zz resolved to nothing and ~open to two scopes, so both stay in the title until one is chosen.
    expect(screen.getByText("Hang truss #zz ~open")).toBeTruthy();
    const choice = screen.getByRole("combobox", { name: "Choose a match for ~open" });
    await userEvent.selectOptions(choice, "s2");
    expect(screen.getByText("Open Air Stage")).toBeTruthy();
    expect(screen.getByText("Hang truss #zz")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /^Hang truss #zz, with Owner: Dana Kim, Scope: Open Air Stage, Kind: Task, and When: Fri, Oct 9, 8:00/,
      ),
    );
    // Typing more never asks again about tokens already resolved.
    expect(resolve.calls).toEqual([["person:dan", "tag:zz", "scope:open", "kind:task"]]);
    await expectAccessible(container);

    // The date chip's remove button is reachable with Tab and turns the date back into text.
    const remove = screen.getByRole("button", { name: /^Remove When: Fri, Oct 9/ });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Hang truss #zz Friday 8am")).toBeTruthy();
    expect(document.activeElement).toBe(input);

    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      title: "Hang truss #zz Friday 8am",
      tokens: [
        { type: "person", value: "dan", icon: "User", id: "p1", label: "Dana Kim" },
        { type: "scope", value: "open", icon: "MapPin", id: "s2", label: "Open Air Stage" },
        { type: "kind", value: "task", icon: "Shapes", id: "Task", label: "Task" },
      ],
    });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("waits for resolutions still out when Enter comes first", async () => {
    const resolve = directory();
    const onSubmit = vi.fn();
    render(<QuickAdd referenceDate={monday} resolve={resolve} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Quick add" }), "Rig @dan{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      title: "Rig",
      tokens: [{ type: "person", id: "p1" }],
    });
  });

  it("keeps the line when the save fails, and treats a failed lookup as unresolved", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("offline");
    });
    const onSubmit = vi.fn(async () => false);
    render(<QuickAdd referenceDate={monday} resolve={resolve} onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox", { name: "Quick add" });
    await userEvent.type(input, "Rig @dan{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ title: "Rig @dan", tokens: [] }));
    expect((input as HTMLInputElement).value).toBe("Rig @dan");
  });

  it("reads dates in Spanish under an es-US provider and names chips in its copy", async () => {
    render(
      <XOSProvider locale="es-US" messages={{ "chip.remove": "Quitar {label}" }}>
        <QuickAdd referenceDate={monday} timeZone="America/New_York" onSubmit={() => undefined} />
      </XOSProvider>,
    );
    await userEvent.type(screen.getByRole("textbox"), "Colgar truss viernes 8am");
    const chips = screen.getByText("Colgar truss").parentElement as HTMLElement;
    expect(within(chips).getByText("viernes 8am")).toBeTruthy();
    expect(within(chips).getByRole("button", { name: /^Quitar vie, 9 de oct/ })).toBeTruthy();
  });

  it("without the app's copy, names chips as typed and lists them in the announcement", async () => {
    const resolve = directory();
    render(<QuickAdd referenceDate={monday} resolve={resolve} onSubmit={() => undefined} />);
    await userEvent.type(screen.getByRole("textbox"), "Rig @dan @x ~open #zz");
    await screen.findByText("Dana Kim");
    expect(screen.getByRole("button", { name: "Remove Dana Kim" })).toBeTruthy();
    const choice = screen.getByRole("combobox", { name: "~open" });
    expect(within(choice).getByRole("option", { name: "open (2)" })).toBeTruthy();
    await waitFor(() =>
      // The second person, the unchosen scope and the unknown tag stay in the title.
      expect(screen.getByRole("status").textContent).toBe("Rig @x ~open #zz and Dana Kim"),
    );
  });
});
