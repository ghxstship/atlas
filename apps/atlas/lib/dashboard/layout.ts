import type { DashboardSpans } from "@xos/ui";

/**
 * A person's dashboard layouts (Section 11.6, A129): the spans they gave the tiles of Home, the
 * partner console, Home > Today and Show > Show day, each kept as one of their own settings for every
 * org (migrations 2220 and 2953). A value is
 * `tile:span` pairs, such as "checklist:8,plan:4"; reading it skips a pair whose tile id or span does
 * not fit, so a hand-edited or stale value can never break the page, and a tile the person does not
 * see simply keeps no span.
 */
export const DASHBOARD_LAYOUT_SETTINGS = {
  home: "me.dashboard_layout.home",
  partner: "me.dashboard_layout.partner",
  today: "me.dashboard_layout.today",
  showDay: "me.dashboard_layout.show_day",
} as const;

export type DashboardId = keyof typeof DASHBOARD_LAYOUT_SETTINGS;

/** The tiles each dashboard can show; a saved span names one of them. */
export const DASHBOARD_TILES: Readonly<Record<DashboardId, readonly string[]>> = {
  home: [
    "partner-console",
    "checklist",
    "plan",
    "active",
    "blocked",
    "due-today",
    "open-blockers",
    "readiness",
    "alerts",
    "activity",
  ],
  partner: ["clients", "owners-joined", "sessions", "seats"],
  // B6: Home > Today and Show > Show day.
  today: ["doors", "approvals", "changes", "today"],
  showDay: ["sets", "run-of-show", "arrivals", "hotels"],
};

/** The longest value the settings hold (migrations 2220 and 2953). */
export const LAYOUT_MAX_LENGTH = 600;

const PAIR = /^([a-z][a-z0-9-]{0,39}):(\d{1,2})$/;

export function isDashboardId(value: string): value is DashboardId {
  return Object.hasOwn(DASHBOARD_LAYOUT_SETTINGS, value);
}

/** The spans a stored value names; anything that does not parse is left out. */
export function parseLayout(value: unknown): DashboardSpans {
  if (typeof value !== "string" || value === "") return {};
  const out: Record<string, number> = {};
  for (const part of value.split(",")) {
    const match = PAIR.exec(part.trim());
    if (!match) continue;
    const span = Number(match[2]);
    if (span >= 1 && span <= 12) out[match[1] as string] = span;
  }
  return out;
}

/**
 * The stored form of a dashboard's spans, or null when one names a tile the dashboard does not have,
 * a span outside 1 to 12, or the value grows too long.
 */
export function formatLayout(dashboard: DashboardId, spans: DashboardSpans): string | null {
  const tiles = DASHBOARD_TILES[dashboard];
  const parts: string[] = [];
  for (const [id, span] of Object.entries(spans)) {
    const pair = `${id}:${span}`;
    if (!tiles.includes(id) || !Number.isInteger(span) || !PAIR.test(pair)) return null;
    if (span < 1 || span > 12) return null;
    parts.push(pair);
  }
  const value = parts.join(",");
  return value.length <= LAYOUT_MAX_LENGTH ? value : null;
}

/** A dashboard's saved spans from the viewer's resolved settings. */
export function savedLayout(
  dashboard: DashboardId,
  read: (key: string) => unknown,
): DashboardSpans {
  return parseLayout(read(DASHBOARD_LAYOUT_SETTINGS[dashboard]));
}
