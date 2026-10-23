import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  DataTable,
  DatePicker,
  PreferencesProvider,
  RecordList,
  RecordRow,
  XOSProvider,
  applyDocumentAttributes,
  convertArea,
  convertUnit,
  displayTimeZone,
  decodePreferences,
  documentAttributes,
  encodePreferences,
  preferencesCookie,
  formatDate,
  formatDistance,
  formatMeasure,
  formatZonedDateTime,
  monthCells,
  preferencesFromSettings,
  regionOfLocale,
  resolveUnitSystem,
  singleKeyShortcutsEnabled,
  toDisplayUnit,
  toStoredUnit,
  unitSystemForRegion,
  useHotkey,
  usePreferences,
  useUnitSystem,
  useViewerTimeZone,
  useZonedTime,
  weekStart,
  weekdayNames,
  type DisplayPreferences,
} from "../src/index.ts";

/**
 * Display preferences from the settings registry (A65-001): each setting is changed here and its effect on
 * the components observed.
 */

const settings = new Map<string, unknown>([
  ["me.text_size", "larger"],
  ["me.high_contrast", true],
  ["me.reduced_motion", "reduce"],
  ["shell.density", "compact"],
  ["me.shortcuts_enabled", false],
  ["locale.date_format", "iso"],
  ["locale.units", "metric"],
  ["payroll.week_start", "monday"],
  ["me.time_zone_display", "viewer"],
]);

const chosen: DisplayPreferences = {
  textSize: "larger",
  contrast: "more",
  motion: "reduce",
  density: "compact",
  shortcuts: false,
  dateFormat: "iso",
  units: "metric",
  weekStart: 1,
  timeZoneDisplay: "viewer",
};

afterEach(() => {
  applyDocumentAttributes(document.documentElement, DEFAULT_PREFERENCES);
});

describe("preferences from settings", () => {
  it("reads each registered setting", () => {
    expect(preferencesFromSettings(settings)).toEqual(chosen);
    expect(preferencesFromSettings((key) => settings.get(key))).toEqual(chosen);
  });

  it("falls back to the defaults for unset or unknown values", () => {
    expect(preferencesFromSettings(new Map())).toEqual(DEFAULT_PREFERENCES);
    expect(
      preferencesFromSettings(
        new Map<string, unknown>([
          ["me.text_size", "huge"],
          ["payroll.week_start", "sunday"],
        ]),
      ),
    ).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips through the cookie, which holds only what differs", () => {
    expect(encodePreferences(DEFAULT_PREFERENCES)).toBe("");
    expect(decodePreferences(encodePreferences(chosen))).toEqual(chosen);
    expect(decodePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(decodePreferences("x.1|t.huge|w.0")).toEqual(DEFAULT_PREFERENCES);
  });

  it("keeps the cookie in the browser, expiring it at the defaults", () => {
    expect(preferencesCookie("t.large|d.compact", true)).toBe(
      "xos-prefs=t.large|d.compact; path=/; max-age=31536000; samesite=lax; secure",
    );
    expect(preferencesCookie("", false)).toBe("xos-prefs=; path=/; max-age=0; samesite=lax");
    expect(preferencesCookie("t.large;evil=1", false)).toBe(
      "xos-prefs=; path=/; max-age=0; samesite=lax",
    );
  });

  it("sets the document attributes the styles read", () => {
    expect(documentAttributes(DEFAULT_PREFERENCES)).toEqual({});
    expect(documentAttributes(chosen)).toEqual({
      "data-text-size": "larger",
      "data-contrast": "more",
      "data-motion": "reduce",
      "data-density": "compact",
      "data-shortcuts": "off",
    });
    const root = document.documentElement;
    applyDocumentAttributes(root, chosen);
    expect(root.dataset["textSize"]).toBe("larger");
    expect(singleKeyShortcutsEnabled()).toBe(false);
    applyDocumentAttributes(root, DEFAULT_PREFERENCES);
    expect(root.hasAttribute("data-text-size")).toBe(false);
    expect(singleKeyShortcutsEnabled()).toBe(true);
  });

  it("styles each attribute: zoom, contrast and motion", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");
    expect(css).toContain(':root[data-text-size="large"] body');
    expect(css).toContain(':root[data-contrast="more"]');
    expect(css).toContain(':root[data-motion="reduce"] *');
    expect(css).toContain(':root:not([data-motion="full"]) *');
  });
});

describe("format helpers", () => {
  it("formats dates as year-month-day under locale.date_format iso", () => {
    expect(formatDate("en-US", "2027-06-04", "iso")).toBe("2027-06-04");
    expect(formatDate("en-US", "2027-06-04")).toBe("Jun 4, 2027");
  });

  it("starts the week on the person's day under payroll.week_start", () => {
    expect(weekStart("en-US", 1)).toBe(1);
    expect(weekdayNames("en-US", 1)[0]).toBe("Mon");
    expect(weekdayNames("en-US", 0)[0]).toBe("Sun");
    // June 2027 starts on a Tuesday: one empty cell from Monday, two from Sunday.
    expect(monthCells("en-US", 2027, 5, 1)[0]?.slice(0, 2)).toEqual([null, 1]);
    expect(monthCells("en-US", 2027, 5, 0)[0]?.slice(0, 3)).toEqual([null, null, 1]);
  });

  it("converts areas and distances to the person's units under locale.units", () => {
    expect(convertArea(1000, "imperial")).toEqual({ value: 1000, unit: "squareFoot" });
    expect(convertArea(1000, "metric")).toEqual({ value: 92.9, unit: "squareMeter" });
    expect(formatDistance("en-US", 120, "metric")).toBe("120 m");
    expect(formatDistance("en-US", 2500, "metric")).toBe("2.5 km");
    expect(formatDistance("en-US", 120, "imperial")).toBe("394 ft");
    expect(formatDistance("en-US", 3218.688, "imperial")).toBe("2 mi");
  });

  it("follows the project's jurisdiction under locale.units jurisdiction, and a fixed choice otherwise", () => {
    expect(DEFAULT_PREFERENCES.units).toBe("jurisdiction");
    // Section 15: imperial for the United States, metric otherwise.
    expect(unitSystemForRegion("US")).toBe("imperial");
    expect(unitSystemForRegion("GB")).toBe("metric");
    expect(unitSystemForRegion(null)).toBe("metric");
    expect(regionOfLocale("es-US")).toBe("US");
    expect(regionOfLocale("fr")).toBe("FR");
    expect(resolveUnitSystem("jurisdiction", { jurisdiction: "metric", locale: "en-US" })).toBe(
      "metric",
    );
    expect(resolveUnitSystem("jurisdiction", { locale: "en-US" })).toBe("imperial");
    expect(resolveUnitSystem("jurisdiction", { locale: "de-DE" })).toBe("metric");
    expect(resolveUnitSystem("imperial", { jurisdiction: "metric" })).toBe("imperial");
    const fromSettings = preferencesFromSettings(new Map([["locale.units", "jurisdiction"]]));
    expect(fromSettings.units).toBe("jurisdiction");
    expect(
      decodePreferences(encodePreferences({ ...DEFAULT_PREFERENCES, units: "imperial" })).units,
    ).toBe("imperial");
  });

  it("shows lengths, weights, temperatures and speeds in the person's units under locale.units", () => {
    expect(formatMeasure("en-US", 25, "mile-per-hour", "metric", 0)).toBe("40 km/h");
    expect(formatMeasure("en-US", 25, "mile-per-hour", "imperial", 0)).toBe("25 mph");
    expect(formatMeasure("en-US", 95, "fahrenheit", "metric", 0)).toBe("35°C");
    expect(formatMeasure("en-US", 95, "fahrenheit", "imperial", 0)).toBe("95°F");
    expect(formatMeasure("en-US", 6, "mile", "metric")).toBe("9.7 km");
    expect(formatMeasure("en-US", 12, "meter", "imperial", 0)).toBe("39 ft");
    expect(formatMeasure("en-US", 100, "pound", "metric")).toBe("45.4 kg");
    expect(convertUnit(0, "celsius", "fahrenheit")).toBe(32);
    expect(() => convertUnit(1, "meter", "pound")).toThrow();
    // A value typed in km/h is saved in mph, and shown back as typed.
    expect(toStoredUnit(40, "mile-per-hour", "metric")).toBeCloseTo(24.855, 3);
    expect(
      toDisplayUnit(toStoredUnit(40, "mile-per-hour", "metric"), "mile-per-hour", "metric"),
    ).toBe(40);
    expect(toStoredUnit(30, "fahrenheit", "metric")).toBeCloseTo(86, 6);
  });
});

describe("schedule times under me.time_zone_display", () => {
  const at = "2026-10-21T23:30:00Z";

  it("labels every time with its zone abbreviation", () => {
    expect(formatZonedDateTime("en-US", at, "America/New_York")).toBe("Oct 21, 2026, 7:30 PM EDT");
    expect(formatZonedDateTime("en-US", at, "America/Los_Angeles", "time")).toBe("4:30 PM PDT");
  });

  it("shows the event's zone by default and the viewer's own when they choose it", () => {
    expect(displayTimeZone("America/New_York", "event", "Europe/Madrid")).toBe("America/New_York");
    expect(displayTimeZone("America/New_York", "viewer", "Europe/Madrid")).toBe("Europe/Madrid");
    expect(displayTimeZone("America/New_York", "viewer", null)).toBe("America/New_York");
    expect(displayTimeZone(null, "event", "Europe/Madrid")).toBe("Europe/Madrid");
    expect(displayTimeZone(undefined, "event", undefined)).toBeUndefined();
  });

  it("formats through the provider's choice and the viewer's zone", () => {
    function Probe() {
      const zoned = useZonedTime();
      return (
        <>
          <span>{zoned.dateTime(at, "America/New_York")}</span>
          <span>{useViewerTimeZone()}</span>
          <span>{useUnitSystem(null)}</span>
        </>
      );
    }
    const { unmount } = render(
      <XOSProvider>
        <PreferencesProvider preferences={DEFAULT_PREFERENCES} timeZone="America/Los_Angeles">
          <Probe />
        </PreferencesProvider>
      </XOSProvider>,
    );
    expect(screen.getByText("Oct 21, 2026, 7:30 PM EDT")).toBeTruthy();
    expect(screen.getByText("imperial")).toBeTruthy();
    unmount();
    render(
      <XOSProvider locale="de-DE">
        <PreferencesProvider preferences={chosen} timeZone="America/Los_Angeles">
          <Probe />
        </PreferencesProvider>
      </XOSProvider>,
    );
    expect(screen.getByText("America/Los_Angeles")).toBeTruthy();
    expect(screen.getByText(/16:30 GMT-7/)).toBeTruthy();
    expect(screen.getByText("metric")).toBeTruthy();
  });
});

describe("components follow the provider's preferences", () => {
  const columns = [{ key: "name", label: "Line" }];
  const rows = [{ name: "Line Array Package" }];

  it("uses compact rows under shell.density compact unless the table chooses", () => {
    const { unmount } = render(
      <XOSProvider preferences={chosen}>
        <DataTable caption="Lines" columns={columns} rows={rows} />
      </XOSProvider>,
    );
    const row = within(screen.getByRole("grid")).getAllByRole("row")[1];
    expect(row?.className).toContain("h-row-compact");
    unmount();
    render(
      <XOSProvider preferences={chosen}>
        <DataTable caption="Chosen" columns={columns} rows={rows} density="comfortable" />
      </XOSProvider>,
    );
    const chosenRow = within(screen.getByRole("grid")).getAllByRole("row")[1];
    expect(chosenRow?.className).toContain("h-row-comfortable");
  });

  it("packs the phone cards closer under shell.density compact", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const { unmount } = render(
      <XOSProvider preferences={chosen}>
        <DataTable caption="Lines" columns={columns} rows={rows} />
      </XOSProvider>,
    );
    const card = within(screen.getByRole("region", { name: "Lines" })).getAllByRole("listitem")[0];
    expect(card?.className).toContain("p-8");
    unmount();
    render(
      <XOSProvider>
        <DataTable caption="Lines" columns={columns} rows={rows} />
      </XOSProvider>,
    );
    const roomy = within(screen.getByRole("region", { name: "Lines" })).getAllByRole("listitem")[0];
    expect(roomy?.className).toContain("p-12");
    matchMedia.mockRestore();
  });

  it("shows picked dates in the person's date format", () => {
    render(
      <XOSProvider preferences={chosen}>
        <DatePicker label="Load-in" value="2027-06-04" today="2027-06-01" />
      </XOSProvider>,
    );
    expect(screen.getByRole("button", { name: /Load-in/ }).textContent).toContain("2027-06-04");
  });

  it("exposes the preferences to the app", () => {
    function Probe() {
      return <span>{usePreferences().units}</span>;
    }
    render(
      <XOSProvider preferences={chosen}>
        <Probe />
      </XOSProvider>,
    );
    expect(screen.getByText("metric")).toBeTruthy();
  });

  it("lets the shell set the resolved preferences below the root provider", () => {
    function Probe() {
      return <span>{usePreferences().dateFormat}</span>;
    }
    render(
      <XOSProvider>
        <PreferencesProvider preferences={chosen}>
          <Probe />
        </PreferencesProvider>
      </XOSProvider>,
    );
    expect(screen.getByText(chosen.dateFormat)).toBeTruthy();
  });

  it("ignores single-key shortcuts while me.shortcuts_enabled is off, keeping Cmd shortcuts", () => {
    const single = vi.fn();
    const withMod = vi.fn();
    function Keys() {
      useHotkey("?", single);
      useHotkey("k", withMod, { mod: true });
      return null;
    }
    render(<Keys />);
    applyDocumentAttributes(document.documentElement, chosen);
    fireEvent.keyDown(document, { key: "?" });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(single).not.toHaveBeenCalled();
    expect(withMod).toHaveBeenCalledTimes(1);
    applyDocumentAttributes(document.documentElement, DEFAULT_PREFERENCES);
    fireEvent.keyDown(document, { key: "?" });
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("stops J, K and X in record lists while shortcuts are off", () => {
    const select = vi.fn();
    render(
      <RecordList label="Records">
        <RecordRow
          state="active"
          stateLabel="Active"
          recordKey="NWL-1"
          title="First"
          onSelect={select}
        />
        <RecordRow state="active" stateLabel="Active" recordKey="NWL-2" title="Second" />
      </RecordList>,
    );
    const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
    rows[0]?.focus();
    applyDocumentAttributes(document.documentElement, chosen);
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "j" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "x" });
    expect(select).not.toHaveBeenCalled();
    applyDocumentAttributes(document.documentElement, DEFAULT_PREFERENCES);
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "j" });
    expect(document.activeElement).toBe(rows[1]);
  });
});
