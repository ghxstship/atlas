import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enXA from "@xos/i18n/messages/pseudo/en-XA.json" with { type: "json" };
import {
  XOSProvider,
  applyTheme,
  catalogFor,
  configure,
  directionOf,
  flattenMessages,
  formatClock,
  formatCompact,
  formatCurrency,
  formatDate,
  formatList,
  formatTimeOfDay,
  isThemePreference,
  monthCells,
  monthTitle,
  parseIso,
  resolveTheme,
  t,
  toIso,
  translate,
  useFormat,
  useLocale,
  useT,
  weekStart,
  weekdayNames,
} from "../src/index.ts";

afterEach(() => configure({ locale: "en-US" }));

describe("t and translate", () => {
  it("prefixes ui. and reads the en-US catalog", () => {
    expect(t("money.unpriced")).toBe("Unpriced");
    expect(catalogFor("en-US")["action.close"]).toBe("Close");
    expect(Object.keys(catalogFor("en-US"))).toHaveLength(319);
  });

  it("reads es-US with identical keys", () => {
    expect(Object.keys(catalogFor("es-US")).sort()).toEqual(
      Object.keys(catalogFor("en-US")).sort(),
    );
    expect(translate("es-US", "money.unpriced")).not.toBe("Unpriced");
  });

  it("fills arguments and formats numbers for the locale", () => {
    expect(t("phase.gateName", { n: 3, name: "Advance" })).toBe("Gate 3 · Advance");
    expect(t("bulk.selected", { n: 12000 })).toBe("12,000 selected");
    expect(t("count.of", { n: 1 })).toBe("1 of {total}");
  });

  it("returns the key for an unknown message and falls back to en-US for other locales", () => {
    expect(t("nope.missing")).toBe("nope.missing");
    expect(translate("fr-FR", "action.close")).toBe("Close");
  });

  it("merges configured messages, including a flattened pseudo-locale", () => {
    const pseudo = flattenMessages(enXA);
    configure({ locale: "en-XA", messages: pseudo });
    expect(t("action.close")).toBe(pseudo["action.close"]);
    expect(t("action.close")).not.toBe("Close");
    configure({
      messages: Object.fromEntries(
        Object.keys(pseudo).map((k) => [k, catalogFor("en-US")[k] ?? k]),
      ),
    });
  });

  it("finds right-to-left locales", () => {
    expect(directionOf("ar-XB")).toBe("rtl");
    expect(directionOf("he")).toBe("rtl");
    expect(directionOf("es-US")).toBe("ltr");
  });
});

function Probe() {
  const tr = useT();
  const fmt = useFormat();
  return (
    <p>
      {useLocale()}|{tr("action.close")}|{fmt.number(1234.5)}|{fmt.currency(5)}|{fmt.compact(12000)}
      |{fmt.list(["A", "B"])}|{fmt.date("2026-11-01")}
    </p>
  );
}

describe("XOSProvider", () => {
  it("binds copy and formatting to its locale and sets direction", () => {
    render(
      <XOSProvider locale="es-US" messages={{ "action.close": "Cerrar ahora" }}>
        <Probe />
      </XOSProvider>,
    );
    const text = screen.getByText(/es-US/).textContent ?? "";
    expect(text).toContain("Cerrar ahora");
    expect(text).toContain("A y B");
  });

  it("falls back to configure outside a provider", () => {
    render(<Probe />);
    expect(screen.getByText(/en-US/).textContent).toContain(
      "Close|1,234.5|$5.00|12K|A and B|Nov 1, 2026",
    );
  });

  it("applies a theme to the document root while mounted", () => {
    const { unmount } = render(
      <XOSProvider theme="sunlight">
        <span>x</span>
      </XOSProvider>,
    );
    expect(document.documentElement.dataset["theme"]).toBe("sunlight");
    unmount();
  });
});

describe("themes", () => {
  it("resolves system from the operating system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light")).toBe("light");
    expect(isThemePreference("sunlight")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
  });

  it("follows the operating system for System until cleanup", () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    const remove = vi.fn();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
      removeEventListener: remove,
    } as unknown as MediaQueryList);
    const el = document.createElement("div");
    const stop = applyTheme("system", el);
    expect(el.dataset["theme"]).toBe("light");
    listeners[0]?.({ matches: true });
    expect(el.dataset["theme"]).toBe("dark");
    stop();
    expect(remove).toHaveBeenCalled();
    expect(applyTheme("dark", el)).toBeTypeOf("function");
    expect(el.dataset["themePreference"]).toBe("dark");
    vi.restoreAllMocks();
  });
});

describe("format", () => {
  it("formats money, compact values, lists, dates and times", () => {
    expect(formatCurrency("en-US", 1200)).toBe("$1,200.00");
    expect(formatCompact("en-US", 12500, "USD")).toBe("$12.5K");
    expect(formatList("en-US", ["A", "B", "C"])).toBe("A, B, and C");
    expect(formatDate("en-US", "2026-10-09")).toBe("Oct 9, 2026");
    expect(formatTimeOfDay("en-US", 14, 30)).toBe("2:30 PM");
    expect(monthTitle("en-US", 2026, 10)).toBe("November 2026");
  });

  it("builds calendar weeks from the locale week start", () => {
    expect(weekStart("en-US")).toBe(0);
    expect(weekStart("not a locale !!")).toBe(0);
    expect(weekdayNames("en-US")[0]).toBe("Sun");
    const weeks = monthCells("en-US", 2026, 10);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(30);
    expect(toIso(2026, 0, 5)).toBe("2026-01-05");
    expect(parseIso("2026-11-01")).toEqual({ y: 2026, m: 10, d: 1 });
  });

  it("formats clocks with overrun", () => {
    expect(formatClock(75)).toBe("01:15");
    expect(formatClock(-5)).toBe("+00:05");
  });
});
