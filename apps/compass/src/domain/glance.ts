/**
 * What Compass shows outside the app (Section 13 Platform features; A65-011 part 4): the iOS home screen
 * and Lock Screen widgets (today's shifts and the next cue) and the Android ongoing notification (the
 * running shift and the next cue, as the iOS Live Activity shows them). Pure functions: the screens
 * compute the content, the runtime hands it to WidgetKit or to the notification tray.
 *
 * Every time is formatted on its own calendar (the item's project zone, A71) and every word comes from the
 * person's catalog, so the widgets and the notification read like the app.
 */
import type { ClockSnapshot } from "./clock";
import type { NextCue } from "./liveActivity";

export type Translate = (key: string, values?: Readonly<Record<string, string>>) => string;

export interface GlanceShift {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** The zone the shift's times read in: its own or its project's. */
  readonly zone: string;
  /** The org's brand name, when the person works for several orgs. */
  readonly org: string | null;
}

export interface GlanceCue extends NextCue {
  readonly project: string | null;
  readonly zone: string;
}

/** A time of day in a zone, in the person's locale. */
export type FormatTime = (iso: string, zone: string) => string;

/** The JSON the widgets read from the App Group (targets/ClockActivity/CompassWidgets.swift). */
export interface WidgetPayload {
  readonly title: string;
  readonly empty: string;
  readonly nextCueTitle: string;
  readonly noCue: string;
  readonly link: string;
  readonly shifts: readonly {
    readonly id: string;
    readonly title: string;
    readonly time: string;
    readonly org: string | null;
    readonly startsAt: number;
    readonly endsAt: number;
  }[];
  readonly cue: {
    readonly label: string;
    readonly at: number;
    readonly project: string | null;
  } | null;
}

/** The widgets show at most this many of today's shifts. */
export const WIDGET_SHIFTS = 4;

export function widgetPayload(
  shifts: readonly GlanceShift[],
  cue: GlanceCue | null,
  t: Translate,
  formatTime: FormatTime,
  link: string,
): WidgetPayload {
  return {
    title: t("compass.glance.today"),
    empty: t("compass.today.noShifts"),
    nextCueTitle: t("compass.today.nextCue"),
    noCue: t("compass.glance.noCue"),
    link,
    shifts: [...shifts]
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .slice(0, WIDGET_SHIFTS)
      .map((s) => ({
        id: s.id,
        title: s.title,
        time: t("compass.schedule.timeRange", {
          start: formatTime(s.startsAt, s.zone),
          end: formatTime(s.endsAt, s.zone),
        }),
        org: s.org,
        startsAt: Date.parse(s.startsAt),
        endsAt: Date.parse(s.endsAt),
      })),
    // A cue to be confirmed has no time to count down to: the widgets show its TBC label as text.
    ...(cue?.tbc ? { noCue: cue.label } : {}),
    cue: cue && !cue.tbc ? { label: cue.label, at: cue.at, project: cue.project } : null,
  };
}

/** The Android ongoing notification: what it says, or null when there is nothing to keep in the tray. */
export interface OngoingContent {
  readonly title: string;
  readonly body: string;
}

/** A cue this close shows in the tray even while clocked out (as the iOS cue Live Activity does). */
export const ONGOING_CUE_LEAD_MS = 2 * 3600_000;

export function ongoingContent(
  snapshot: ClockSnapshot,
  cue: GlanceCue | null,
  projectName: string,
  nowMs: number,
  t: Translate,
  formatTime: FormatTime,
  zone: string,
): OngoingContent | null {
  const cueLine =
    cue && cue.at >= nowMs - 3600_000
      ? cue.tbc
        ? t("compass.glance.cueTitle", { cue: cue.label })
        : t("compass.glance.cueLine", {
            cue: cue.label,
            time: formatTime(new Date(cue.at).toISOString(), cue.zone),
          })
      : null;
  if (snapshot.state !== "out" && snapshot.onSince !== null) {
    const onBreak = snapshot.state === "break" && snapshot.breakSince !== null;
    const since = formatTime(
      new Date(
        onBreak ? (snapshot.breakSince ?? snapshot.onSince) : snapshot.onSince,
      ).toISOString(),
      zone,
    );
    return {
      title: t(onBreak ? "compass.glance.onBreakTitle" : "compass.glance.onShiftTitle", {
        project: projectName,
      }),
      body: [t("compass.glance.since", { time: since }), cueLine].filter(Boolean).join(" · "),
    };
  }
  if (cue && cueLine && cue.at - nowMs <= ONGOING_CUE_LEAD_MS) {
    return {
      title: t("compass.glance.cueTitle", { cue: cue.label }),
      body: cue.tbc
        ? (cue.project ?? cueLine)
        : cue.project
          ? t("compass.glance.cueBody", {
              project: cue.project,
              time: formatTime(new Date(cue.at).toISOString(), cue.zone),
            })
          : cueLine,
    };
  }
  return null;
}

/**
 * The widget gallery's names and descriptions (A140). WidgetKit reads them from the extension's Localizable.strings
 * before Compass has run, so they cannot come from the App Group like the widgets' content. CompassWidgets.swift
 * writes each in en-US as its lookup key; targets/ClockActivity/<language>.lproj/Localizable.strings maps it to the
 * catalog text of that language (`pnpm --filter @xos/compass generate:widget-strings`).
 */
export const WIDGET_GALLERY_KEYS: readonly string[] = [
  "compass.glance.gallery.todayName",
  "compass.glance.gallery.todayDescription",
  "compass.glance.gallery.nextCueName",
  "compass.glance.gallery.nextCueDescription",
];

/** The extension languages and the catalog each reads. */
export const WIDGET_GALLERY_LANGUAGES: readonly {
  readonly lproj: string;
  readonly locale: string;
}[] = [
  { lproj: "en", locale: "en-US" },
  { lproj: "es", locale: "es-US" },
];

function stringsLiteral(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/** A Localizable.strings file: each gallery text's en-US key to its text in one language. */
export function widgetGalleryStrings(english: Translate, language: Translate): string {
  return [
    "/* Generated by apps/compass/test/widget-gallery.test.ts from the compass.glance.gallery catalog keys. */",
    "/* Never edit by hand: run pnpm --filter @xos/compass generate:widget-strings. */",
    ...WIDGET_GALLERY_KEYS.map(
      (key) => `${stringsLiteral(english(key))} = ${stringsLiteral(language(key))};`,
    ),
    "",
  ].join("\n");
}
