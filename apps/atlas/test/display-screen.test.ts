/**
 * P1 (RRR-215, ADR 0130): a display screen announces now and next politely, once per called cue.
 * Only the cue labels sit in aria-live regions; the timers, which change every second, are
 * role="timer" (never announced on its own), so no live region holds a ticking m:ss value in any
 * mode and a screen reader on the screen is not read the time every second (WCAG 4.1.3, 2.2.2).
 */
import { getMessages } from "@xos/i18n";
import { DISPLAY_MODES, type DisplayMode, type PublicCue } from "@xos/data/live-links";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { DisplayScreen } = await import("@/components/show/display-screen");

const messages = getMessages("en-US");
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

/** The inner markup of each element that carries aria-live, matched to its own closing tag. */
function liveRegions(html: string): string[] {
  const regions: string[] = [];
  const open = /<(\w+)\b[^>]*\baria-live="polite"[^>]*>/g;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const tag = m[1] ?? "";
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
    tags.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = html.length;
    for (let t = tags.exec(html); t; t = tags.exec(html)) {
      depth += t[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    regions.push(html.slice(m.index + m[0].length, end));
  }
  return regions;
}

const NOW = "2026-11-14T20:00:00.000Z";
const cues: PublicCue[] = [
  {
    position: 1,
    label: "Doors open",
    segment: "Arrivals",
    plannedAt: "2026-11-14T19:58:00.000Z",
    durationSeconds: 600,
    calledAt: "2026-11-14T19:58:30.000Z",
  },
  {
    position: 2,
    label: "Opening act",
    segment: null,
    plannedAt: "2026-11-14T20:08:00.000Z",
    durationSeconds: 1800,
    calledAt: null,
  },
];

function screen(mode: DisplayMode, list: readonly PublicCue[] = cues): string {
  return render(
    createElement(DisplayScreen, {
      cues: list,
      name: "Main stage",
      projectName: "Northwind Summer Series",
      brandName: "Northwind Live",
      timeZone: "UTC",
      defaultMode: mode,
      serverNow: NOW,
    }),
  );
}

describe("display screen announcements", () => {
  it.each(DISPLAY_MODES)("keeps every ticking value out of the live regions in %s", (mode) => {
    const html = screen(mode);
    const regions = liveRegions(html);
    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) expect(region).not.toMatch(/\d+:\d{2}/);
    expect(regions.join(" ")).toContain("Doors open");
    expect(html).toContain('role="timer"');
  });

  it("puts an overrun's 'Over by' in a timer, never a live region", () => {
    const overrun = cues.map((c) => (c.position === 1 ? { ...c, durationSeconds: 60 } : c));
    for (const mode of DISPLAY_MODES) {
      const html = screen(mode, overrun);
      expect(html).toContain("Over by 0:30");
      for (const region of liveRegions(html)) expect(region).not.toContain("Over by");
    }
  });

  it("announces now and next with their headings in Backstage", () => {
    const regions = liveRegions(screen("Backstage"));
    expect(regions.some((r) => r.includes("Now") && r.includes("Doors open"))).toBe(true);
    expect(regions.some((r) => r.includes("Next") && r.includes("Opening act"))).toBe(true);
  });
});
