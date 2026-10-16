/**
 * Renders the public status page (Section 5.1: components per region for Atlas, API, Realtime,
 * Sync and Notifications) as one static, script-free HTML file per locale.
 *
 * Copy comes from the `status` namespace in packages/i18n. Colors, spacing and type come from the
 * design tokens (packages/tokens CSS), inlined so the page has no runtime dependencies and keeps
 * working when every other XOS surface is down. The light theme follows the reader's system
 * setting. State is never shown by color alone: every mark carries its state as text.
 */

import type { CheckHistory, StatusHistory } from "../../synthetics/src/run.ts";
import type { ComponentId } from "../../synthetics/src/types.ts";

export type ComponentState = "operational" | "degraded" | "outage" | "unknown";

export interface StatusMessages {
  title: string;
  description: string;
  skipLink: string;
  overall: Record<ComponentState, string>;
  state: Record<ComponentState, string>;
  component: Record<ComponentId, string>;
  region: Record<string, string>;
  regionHeading: string;
  uptime: string;
  uptimeUnknown: string;
  historyLabel: string;
  day: string;
  lastChecked: string;
  neverChecked: string;
  incidents: { heading: string; empty: string; started: string; resolved: string; ongoing: string };
  footer: string;
}

export interface StatusConfig {
  readonly regions: readonly string[];
  readonly components: readonly ComponentId[];
  /** A latest result older than this counts as no data. */
  readonly staleAfterMinutes: number;
  /** Days of daily history shown per component. */
  readonly historyDays: number;
  readonly incidentWindowDays: number;
}

export interface Incident {
  readonly id: string;
  readonly components: readonly ComponentId[];
  readonly regions: readonly string[];
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  /** Title and latest update per locale, written by the incident commander. */
  readonly text: Readonly<Record<string, { readonly title: string; readonly update: string }>>;
}

export interface RenderInput {
  readonly locale: string;
  readonly messages: StatusMessages;
  readonly config: StatusConfig;
  readonly history: StatusHistory;
  readonly incidents: readonly Incident[];
  readonly now: Date;
  /** Token stylesheets: base, dark and light, in that order. */
  readonly tokenCss: { readonly base: string; readonly dark: string; readonly light: string };
}

export function format(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const RANK: Readonly<Record<ComponentState, number>> = {
  unknown: 0,
  operational: 1,
  degraded: 2,
  outage: 3,
};

function worst(states: readonly ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "unknown");
}

function checksOf(history: StatusHistory, region: string, component: ComponentId): CheckHistory[] {
  return Object.values(history.regions[region] ?? {}).filter((c) => c.component === component);
}

/** Current state of a component in a region from the latest result of each of its checks. */
export function currentState(
  history: StatusHistory,
  region: string,
  component: ComponentId,
  now: Date,
  staleAfterMinutes: number,
): ComponentState {
  const fresh = now.getTime() - staleAfterMinutes * 60_000;
  const states = checksOf(history, region, component).map((check): ComponentState => {
    const last = check.last;
    if (!last || last.status === "skipped" || Date.parse(last.at) < fresh) return "unknown";
    if (last.status === "fail") return "outage";
    return last.status === "degraded" ? "degraded" : "operational";
  });
  const known = states.filter((s) => s !== "unknown");
  return known.length === 0 ? "unknown" : worst(known);
}

function utcDay(date: Date, offsetDays: number): string {
  return new Date(date.getTime() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export interface DaySummary {
  readonly day: string;
  readonly state: ComponentState;
}

/**
 * Daily state, oldest first: outage below 99 percent of good checks that day, degraded below 100
 * percent or with any slow answer, operational otherwise, unknown with no checks.
 */
export function dailyStates(
  history: StatusHistory,
  region: string,
  component: ComponentId,
  now: Date,
  days: number,
): DaySummary[] {
  const checks = checksOf(history, region, component);
  const out: DaySummary[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = utcDay(now, offset);
    let good = 0;
    let slow = 0;
    let total = 0;
    for (const check of checks) {
      const counts = check.days[day];
      if (!counts) continue;
      good += counts.pass + counts.degraded;
      slow += counts.degraded;
      total += counts.pass + counts.degraded + counts.fail;
    }
    let state: ComponentState = "unknown";
    if (total > 0) {
      const ratio = good / total;
      state = ratio < 0.99 ? "outage" : ratio < 1 || slow > 0 ? "degraded" : "operational";
    }
    out.push({ day, state });
  }
  return out;
}

/** Share of good checks over the window, or null when nothing ran. */
export function uptime(
  history: StatusHistory,
  region: string,
  component: ComponentId,
  now: Date,
  days: number,
): number | null {
  let good = 0;
  let total = 0;
  for (const check of checksOf(history, region, component)) {
    for (let offset = 0; offset < days; offset += 1) {
      const counts = check.days[utcDay(now, offset)];
      if (!counts) continue;
      good += counts.pass + counts.degraded;
      total += counts.pass + counts.degraded + counts.fail;
    }
  }
  return total === 0 ? null : good / total;
}

function lastCheckedAt(
  history: StatusHistory,
  region: string,
  component: ComponentId,
): string | null {
  const times = checksOf(history, region, component)
    .map((c) => c.last?.at)
    .filter((t): t is string => typeof t === "string")
    .sort();
  return times.at(-1) ?? null;
}

const PAGE_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--color-bg-canvas);color:var(--color-text-primary);font:var(--typography-text-14);font-family:var(--font-family-sans)}
a{color:var(--color-accent-text)}
a:focus-visible{outline:var(--stroke-width-focus) solid var(--color-focus-ring);outline-offset:var(--space-2)}
.skip{position:absolute;inset-inline-start:var(--space-16);inset-block-start:calc(-1 * var(--space-64))}
.skip:focus{inset-block-start:var(--space-16)}
main{max-inline-size:var(--layout-reading);margin-inline:auto;padding:var(--space-32) var(--space-16)}
h1{font:var(--typography-heading-24);margin:0 0 var(--space-8)}
h2{font:var(--typography-heading-16);margin:var(--space-32) 0 var(--space-12)}
.lede{color:var(--color-text-secondary);margin:0 0 var(--space-24)}
.banner{border:var(--stroke-width-hairline) solid var(--color-border-subtle);border-radius:var(--radius-card);background:var(--color-bg-surface);padding:var(--space-16);font:var(--typography-heading-16)}
.banner[data-state=outage]{border-color:var(--color-danger)}
.banner[data-state=degraded]{border-color:var(--color-warning)}
.banner[data-state=operational]{border-color:var(--color-success)}
ul.components{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-8)}
.component{border:var(--stroke-width-hairline) solid var(--color-border-subtle);border-radius:var(--radius-card);background:var(--color-bg-surface);padding:var(--space-12) var(--space-16)}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-8);align-items:baseline}
.name{font-weight:var(--font-weight-semibold)}
.state{display:inline-flex;gap:var(--space-6);align-items:center;font:var(--typography-label-13)}
.mark{inline-size:var(--icon-size-12);block-size:var(--icon-size-12);border-radius:var(--radius-pill);background:var(--color-text-tertiary);flex:none}
[data-state=operational]>.mark,.day[data-state=operational]{background:var(--color-success)}
[data-state=degraded]>.mark,.day[data-state=degraded]{background:var(--color-warning)}
[data-state=outage]>.mark,.day[data-state=outage]{background:var(--color-danger)}
.meta{color:var(--color-text-secondary);font:var(--typography-text-12);margin-block-start:var(--space-4)}
ol.days{list-style:none;margin:var(--space-8) 0 0;padding:0;display:flex;gap:var(--space-2)}
.day{flex:1 1 0;min-inline-size:var(--space-2);block-size:var(--space-24);border-radius:var(--radius-mark);background:var(--color-border-strong)}
.sr{position:absolute;inline-size:var(--stroke-width-hairline);block-size:var(--stroke-width-hairline);overflow:hidden;clip-path:inset(50%);white-space:nowrap}
ul.incidents{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-12)}
.incident{border-inline-start:var(--stroke-width-accent) solid var(--color-border-strong);padding-inline-start:var(--space-12)}
footer{color:var(--color-text-tertiary);font:var(--typography-text-12);margin-block-start:var(--space-40)}
@media (prefers-reduced-motion:no-preference){a{transition:color var(--motion-duration-fast) var(--motion-easing-standard)}}
`;

/** Turns the light theme's `[data-theme="light"]` block into a prefers-color-scheme rule. */
export function lightThemeAsMediaQuery(lightCss: string): string {
  return `@media (prefers-color-scheme: light){${lightCss.replace(/\[data-theme="light"\]/g, ":root")}}`;
}

function stateBadge(messages: StatusMessages, state: ComponentState): string {
  return `<span class="state" data-state="${state}"><span class="mark" aria-hidden="true"></span>${escapeHtml(messages.state[state])}</span>`;
}

export function renderStatusPage(input: RenderInput): string {
  const { messages: m, config, history, now, locale } = input;
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const timeFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

  const allStates: ComponentState[] = [];
  const regionSections = config.regions.map((region) => {
    const regionName = m.region[region] ?? region;
    const items = config.components.map((component) => {
      const state = currentState(history, region, component, now, config.staleAfterMinutes);
      allStates.push(state);
      const share = uptime(history, region, component, now, config.historyDays);
      const uptimeText =
        share === null
          ? format(m.uptimeUnknown, { days: config.historyDays })
          : format(m.uptime, { percent: percent.format(share), days: config.historyDays });
      const checked = lastCheckedAt(history, region, component);
      const checkedText = checked
        ? format(m.lastChecked, { time: timeFormat.format(new Date(checked)) })
        : m.neverChecked;
      const days = dailyStates(history, region, component, now, config.historyDays)
        .map(({ day, state: dayState }) => {
          const label = format(m.day, {
            date: dateFormat.format(new Date(`${day}T12:00:00Z`)),
            state: m.state[dayState],
          });
          return `<li class="day" data-state="${dayState}" title="${escapeHtml(label)}"><span class="sr">${escapeHtml(label)}</span></li>`;
        })
        .join("");
      const name = m.component[component];
      return `<li class="component"><div class="row"><span class="name">${escapeHtml(name)}</span>${stateBadge(m, state)}</div><div class="meta">${escapeHtml(uptimeText)}. ${escapeHtml(checkedText)}</div><ol class="days" aria-label="${escapeHtml(format(m.historyLabel, { component: name, region: regionName }))}">${days}</ol></li>`;
    });
    return `<section aria-labelledby="region-${region}"><h2 id="region-${region}">${escapeHtml(format(m.regionHeading, { region: regionName }))}</h2><ul class="components">${items.join("")}</ul></section>`;
  });

  const known = allStates.filter((s) => s !== "unknown");
  const overall: ComponentState = known.length === 0 ? "unknown" : worst(known);

  const windowStart = now.getTime() - config.incidentWindowDays * 86_400_000;
  const recent = input.incidents
    .filter((i) => i.resolvedAt === null || Date.parse(i.resolvedAt) >= windowStart)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const incidentItems = recent.map((incident) => {
    const text = incident.text[locale] ??
      incident.text["en-US"] ?? { title: incident.id, update: "" };
    const when = [
      format(m.incidents.started, { time: timeFormat.format(new Date(incident.startedAt)) }),
      incident.resolvedAt
        ? format(m.incidents.resolved, { time: timeFormat.format(new Date(incident.resolvedAt)) })
        : m.incidents.ongoing,
    ].join(". ");
    const affected = incident.components.map((c) => m.component[c]).join(", ");
    return `<li class="incident"><div class="name">${escapeHtml(text.title)}</div><div class="meta">${escapeHtml(affected)}. ${escapeHtml(when)}</div><p>${escapeHtml(text.update)}</p></li>`;
  });
  const incidents =
    incidentItems.length === 0
      ? `<p class="lede">${escapeHtml(m.incidents.empty)}</p>`
      : `<ul class="incidents">${incidentItems.join("")}</ul>`;

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(m.description)}">
<title>${escapeHtml(m.title)}</title>
<style>${input.tokenCss.base}
${input.tokenCss.dark}
${lightThemeAsMediaQuery(input.tokenCss.light)}
${PAGE_CSS}</style>
</head>
<body>
<a class="skip" href="#components">${escapeHtml(m.skipLink)}</a>
<main>
<h1>${escapeHtml(m.title)}</h1>
<p class="lede">${escapeHtml(m.description)}</p>
<p class="banner" role="status" data-state="${overall}">${escapeHtml(m.overall[overall])}</p>
<div id="components">${regionSections.join("")}</div>
<section aria-labelledby="incidents"><h2 id="incidents">${escapeHtml(m.incidents.heading)}</h2>${incidents}</section>
<footer>${escapeHtml(m.footer)}</footer>
</main>
</body>
</html>
`;
}
