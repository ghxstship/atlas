/**
 * Help for the screen the person is on (Section 11.16). Every Compass screen maps to a help node: a
 * sitemap node id, or one of the screen ids below for screens the sitemap does not route (the
 * workforce suite, the assistant, the kiosk, handoffs and Help itself). Articles name these nodes in
 * their frontmatter, as Atlas and Gateway articles name sitemap nodes (@xos/help).
 */
import { coversNode, type ArticleSummary } from "@xos/help";
import type { Audience } from "@xos/sync";
import { isInternal } from "@xos/sync";
import { tabBar, type MenuEntry } from "./access";

/** Help nodes of screens the sitemap does not route, for internal members only. */
export const INTERNAL_SCREEN_NODES = [
  "workforce",
  "workforce.feed",
  "workforce.surveys",
  "workforce.chat",
  "workforce.directory",
  "workforce.events",
  "workforce.forms",
  "workforce.training",
  "workforce.handbook",
  "workforce.recognition",
  "workforce.help-desk",
  "workforce.occupancy",
  "workforce.weather",
  "workforce.door",
  "workforce.lost-found",
  "aurora",
  "kiosk",
] as const;

/** Help nodes of screens everyone may reach that the sitemap does not route. */
export const SHARED_SCREEN_NODES = ["help", "engagement"] as const;

/**
 * Every Compass screen by its expo-router route, and the help node it shows. `$name` takes the
 * value of the route's `[name]` segment: a reference section is its sitemap node, and a More entry
 * Compass does not render yet is the entry's own node.
 */
export const HELP_SCREENS: Readonly<Record<string, string>> = {
  "/today": "today",
  "/schedule": "schedule",
  "/scan": "scan",
  "/inbox": "inbox",
  "/more": "more",
  "/crew": "crew",
  "/clock-team": "clock-team",
  "/logistics": "logistics",
  "/show": "show",
  "/run-of-show": "run-of-show",
  "/profile": "profile",
  "/offline-queue": "offline-queue",
  "/kiosk": "kiosk",
  "/settings": "settings",
  "/settings/account": "settings.account",
  "/settings/calendar-feeds": "settings.calendar-feeds",
  "/settings/connected-apps": "settings.connected-apps",
  "/settings/delete-account": "settings.account",
  "/settings/developer": "settings.developer",
  "/settings/organizations": "settings.organizations",
  "/settings/payout-and-tax": "settings.payout-and-tax",
  "/settings/profile": "settings.profile",
  "/settings/profile-privacy": "settings.profile-privacy",
  "/settings/security": "settings.security",
  "/settings/accessibility": "settings.accessibility",
  "/settings/notifications": "settings.notifications",
  "/settings/out-of-office": "settings.out-of-office",
  "/settings/preferences": "settings.preferences",
  "/settings/work-details": "settings.work-details",
  "/incidents": "incidents",
  "/incidents/new": "incidents",
  "/inspections": "inspections",
  "/inspections/[templateId]": "inspections",
  "/reference": "reference",
  "/reference/[section]": "reference.$section",
  "/pending/[page]": "$page",
  "/expenses": "expenses",
  "/timesheets": "timesheets",
  "/per-diem": "per-diem",
  "/travel-and-lodging": "travel-and-lodging",
  "/onboarding": "onboarding",
  "/purchase-orders": "purchase-orders",
  "/deliveries": "deliveries",
  "/submittals": "submittals",
  "/time-entries": "time-entries",
  "/deliverables": "deliverables",
  "/advance-summary": "advance-summary",
  "/rider": "rider",
  "/settlement": "settlement",
  "/reports": "reports",
  "/proof-of-performance": "proof-of-performance",
  "/project-details": "project-details",
  "/project-details/[entryId]": "project-details",
  "/r/[recordKey]": "record",
  "/e/[engagementKey]": "engagement",
  "/more/aurora": "aurora",
  "/workforce": "workforce",
  "/workforce/feed": "workforce.feed",
  "/workforce/surveys": "workforce.surveys",
  "/workforce/survey/[surveyId]": "workforce.surveys",
  "/workforce/chat": "workforce.chat",
  "/workforce/chat/[conversationId]": "workforce.chat",
  "/workforce/directory": "workforce.directory",
  "/workforce/events": "workforce.events",
  "/workforce/forms": "workforce.forms",
  "/workforce/forms/[templateId]": "workforce.forms",
  "/workforce/training": "workforce.training",
  "/workforce/handbook": "workforce.handbook",
  "/workforce/recognition": "workforce.recognition",
  "/workforce/help-desk": "workforce.help-desk",
  "/workforce/occupancy": "workforce.occupancy",
  "/workforce/weather": "workforce.weather",
  "/workforce/door": "workforce.door",
  "/workforce/lost-found": "workforce.lost-found",
  "/help": "help",
  "/help/contact": "help",
  "/help/[slug]": "help",
};

/** Screens that lead somewhere else, so Help shows the screen visited before them. */
const HUBS: readonly string[] = ["/more", "/settings", "/help"];

/** The help node of a concrete path, such as /reference/sops, or null for an unknown path. */
export function helpNodeFor(pathname: string): string | null {
  const path = pathname.split("?")[0]?.replace(/\/+$/, "") || "/";
  const exact = HELP_SCREENS[path];
  if (exact !== undefined) return exact;
  const parts = path.split("/");
  for (const [pattern, node] of Object.entries(HELP_SCREENS)) {
    const segments = pattern.split("/");
    if (segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matches = segments.every((segment, i) => {
      const param = /^\[(\w+)\]$/.exec(segment)?.[1];
      if (param) params[param] = parts[i] ?? "";
      return param !== undefined ? (parts[i] ?? "") !== "" : segment === parts[i];
    });
    if (matches) return node.replace(/\$(\w+)/g, (_, name: string) => params[name] ?? "");
  }
  return null;
}

/** Whether a path is a hub (More, Settings, Help), which Help looks past for the screen in use. */
export function isHelpHub(pathname: string): boolean {
  return HUBS.some((hub) => pathname === hub || pathname.startsWith(`${hub}/`));
}

function menuIds(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap((e) => [e.id, ...menuIds(e.children)]);
}

/** The help nodes of every screen an audience can reach. */
export function helpNodesFor(audience: Audience): ReadonlySet<string> {
  return new Set([
    ...menuIds(tabBar(audience)),
    ...SHARED_SCREEN_NODES,
    ...(isInternal(audience) ? INTERNAL_SCREEN_NODES : []),
  ]);
}

/** The articles that help with something the audience can reach, general ones included. */
export function articlesForAudience<A extends ArticleSummary>(
  articles: readonly A[],
  nodes: ReadonlySet<string>,
): A[] {
  return articles.filter((a) =>
    a.nodes.some((p) => p === "*" || [...nodes].some((n) => coversNode(p, n))),
  );
}
