import {
  chromeSlot,
  commandMenuIndex,
  expandedGroups,
  getNode,
  isNodeVisible,
  type NavContext,
  type Sitemap,
  type SitemapNode,
} from "@xos/ia";
import type { SystemRoleCode } from "@xos/data";
import { fillRoute } from "@xos/ia";

/**
 * The navigation model of the Atlas shell, generated from the sitemap for one viewer (Section 4.5.2):
 * the always-visible top items, the pinned Projects entry with the person's recent projects under it, the module
 * groups with the role's default
 * groups expanded and the person's own order and hidden items applied, the footer, the account entry,
 * the phone bottom bar and the command menu index with its shortcut hints. No navigation item is
 * written in a component; everything here comes from ia/sitemap.yaml.
 */

export interface NavLinkModel {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
  /** Links listed under this one: the recent projects and All Projects under the pinned Projects entry. */
  readonly children?: readonly NavLinkModel[];
  /** Names the list of `children` for screen readers. */
  readonly childrenLabel?: string;
}

/** A project the person opened recently, newest first (lib/shell/recents.ts). */
export interface RecentProjectModel {
  readonly key: string;
  readonly name: string;
}

/** How many recent projects the sidebar lists under Projects (Section 4.5.2: the five most recent). */
export const RECENT_PROJECT_COUNT = 5;

export interface NavGroupModel {
  readonly id: string;
  readonly label: string;
  readonly expanded: boolean;
  readonly items: readonly NavLinkModel[];
}

export interface BottomBarItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly href?: string;
  readonly action?: "search" | "menu";
}

export interface CommandGroupModel {
  readonly label: string;
  readonly items: readonly {
    readonly label: string;
    readonly href: string;
    readonly icon: string;
    /** The keys that open the page, as people read them (`G F`), when it has a shortcut. */
    readonly shortcut?: string;
  }[];
}

/** One row of a person's sidebar layout (app.sidebar_item_preferences, Section 4.5.2). */
export interface SidebarLayoutEntry {
  /** A module group (group.production) or one of its items (finance). */
  readonly nodeId: string;
  readonly sortOrder: number;
  readonly hidden: boolean;
}

export interface ShellNav {
  readonly top: readonly NavLinkModel[];
  readonly pinned: readonly NavLinkModel[];
  readonly groups: readonly NavGroupModel[];
  readonly footer: readonly NavLinkModel[];
  readonly account: NavLinkModel | null;
  readonly bottomBar: readonly BottomBarItem[];
  readonly commands: readonly CommandGroupModel[];
}

/** Lucide icons for the sidebar items and chrome actions, keyed by sitemap node id. */
export const NAV_ICONS: Readonly<Record<string, string>> = {
  home: "House",
  inbox: "Inbox",
  "my-work": "CircleCheck",
  projects: "FolderKanban",
  schedule: "CalendarDays",
  work: "ListChecks",
  show: "Clapperboard",
  advancing: "PackageCheck",
  places: "MapPin",
  logistics: "Truck",
  hospitality: "UtensilsCrossed",
  assets: "Boxes",
  credentials: "IdCard",
  safety: "ShieldCheck",
  people: "Users",
  opportunities: "Briefcase",
  crew: "HardHat",
  finance: "Landmark",
  procurement: "ShoppingCart",
  vendors: "Store",
  knowledge: "BookOpen",
  reports: "ChartColumn",
  canon: "Library",
  activity: "Activity",
  settings: "Settings",
  me: "UserRound",
  "action.search": "Search",
  "action.favorites": "Star",
  "action.menu": "Menu",
  project: "Folder",
  "projects.all": "List",
};

/**
 * Personas whose default expanded groups Section 4.5.2 names, by platform role: the default when
 * the person has not chosen a persona for the org in Preferences (setting me.persona).
 */
export const ROLE_PERSONA: Readonly<Record<SystemRoleCode, string | null>> = {
  owner: "org-owner",
  admin: "org-admin",
  manager: "producer",
  member: "department-head",
  collaborator: "production-coordinator",
  field: "field-employee",
  viewer: null,
};

type Translate = (key: string) => string;

/**
 * Items in the person's order: those they placed by position, then any they never placed (a module
 * added since) in the default order.
 */
export function orderByLayout<T extends { readonly id: string }>(
  items: readonly T[],
  layout: ReadonlyMap<string, SidebarLayoutEntry>,
): T[] {
  const placed = items
    .filter((i) => layout.has(i.id))
    .sort((a, b) => (layout.get(a.id)?.sortOrder ?? 0) - (layout.get(b.id)?.sortOrder ?? 0));
  return [...placed, ...items.filter((i) => !layout.has(i.id))];
}

/** The sitemap nodes a person may place or hide in their sidebar: module groups and their items. */
export function sidebarNodeIds(sitemap: Sitemap): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of sitemap.nodes.filter((n) => n.placement === "sidebar")) {
    ids.add(group.id);
    for (const child of group.children ?? []) ids.add(child.id);
  }
  return ids;
}

/** Items in the person's order without the ones they hid. */
function arrange<T extends { readonly id: string }>(
  items: readonly T[],
  layout: ReadonlyMap<string, SidebarLayoutEntry>,
): T[] {
  return orderByLayout(items, layout).filter((i) => !layout.get(i.id)?.hidden);
}

function link(node: SitemapNode, params: Record<string, string>, t: Translate): NavLinkModel[] {
  if (node.route === undefined) return [];
  return [
    {
      id: node.id,
      label: t(node.label),
      href: fillRoute(node.route, params),
      icon: NAV_ICONS[node.id] ?? "Circle",
    },
  ];
}

/**
 * The links under the pinned Projects entry (Section 4.5.2): the five projects the person opened most recently,
 * once each and newest first, then All Projects. None when the viewer may not open a project page or has not
 * opened one yet; the list comes from app.recent_projects, so it holds only projects they can still read.
 */
export function recentProjectLinks(
  sitemap: Sitemap,
  recent: readonly RecentProjectModel[],
  input: {
    readonly nav: NavContext;
    readonly params: Record<string, string>;
    readonly t: Translate;
  },
): NavLinkModel[] {
  const { nav, params, t } = input;
  const route = getNode(sitemap, "project").node.route;
  if (route === undefined || !isNodeVisible(sitemap, "project", nav)) return [];
  const keys = new Set<string>();
  const projects = recent
    .filter((p) => {
      if (keys.has(p.key)) return false;
      keys.add(p.key);
      return true;
    })
    .slice(0, RECENT_PROJECT_COUNT);
  if (projects.length === 0) return [];
  const all = isNodeVisible(sitemap, "projects.all", nav)
    ? link(getNode(sitemap, "projects.all").node, params, t)
    : [];
  return [
    ...projects.map((p) => ({
      id: `project.${p.key}`,
      label: p.name,
      href: fillRoute(route, { ...params, projectKey: p.key }),
      icon: NAV_ICONS["project"] ?? "Circle",
    })),
    ...all,
  ];
}

export function buildShellNav(
  sitemap: Sitemap,
  input: {
    readonly nav: NavContext;
    readonly role: SystemRoleCode | null;
    /** The persona the person chose; null or absent follows the role. */
    readonly persona?: string | null;
    readonly params: Record<string, string>;
    readonly t: Translate;
    /** The person's own order and hidden items; empty or absent is the role default. */
    readonly layout?: readonly SidebarLayoutEntry[];
    /** Shortcut keys as people read them, by the sitemap node they open, for command menu hints. */
    readonly hints?: Readonly<Record<string, string>>;
    /** The projects the person opened most recently, newest first, listed under the pinned Projects entry. */
    readonly recentProjects?: readonly RecentProjectModel[];
  },
): ShellNav {
  const { nav, params, t } = input;
  const layout = new Map((input.layout ?? []).map((entry) => [entry.nodeId, entry]));
  const visible = (id: string) => isNodeVisible(sitemap, id, nav);
  const navigable = (ids: readonly string[]) =>
    ids.filter((id) => getNode(sitemap, id).navigable && visible(id));

  const top = navigable(sitemap.chrome?.["sidebarTop"] ?? []).flatMap((id) =>
    link(getNode(sitemap, id).node, params, t),
  );
  const recent = recentProjectLinks(sitemap, input.recentProjects ?? [], { nav, params, t });
  const pinned = navigable(sitemap.chrome?.["sidebarPinned"] ?? []).flatMap((id) =>
    link(getNode(sitemap, id).node, params, t).map((l) =>
      l.id === "projects"
        ? {
            ...l,
            childrenLabel: t("shell.chrome.recentProjects"),
            ...(recent.length > 0 ? { children: recent } : {}),
          }
        : l,
    ),
  );
  const shownAbove = new Set([...top, ...pinned].map((l) => l.id));
  const persona = input.persona ?? (input.role ? ROLE_PERSONA[input.role] : null);
  const expanded = new Set(persona ? expandedGroups(sitemap, persona) : []);

  const groups = arrange(
    sitemap.nodes
      .filter((n) => n.placement === "sidebar" && visible(n.id))
      .map((group) => ({
        id: group.id,
        label: t(group.label),
        expanded: expanded.has(group.id),
        items: arrange(
          (group.children ?? [])
            .filter((c) => !shownAbove.has(c.id) && visible(c.id))
            .flatMap((c) => link(c, params, t)),
          layout,
        ),
      })),
    layout,
  ).filter((g) => g.items.length > 0);

  const footer = sitemap.nodes
    .filter((n) => n.placement === "footer")
    .flatMap((g) => (g.children ?? []).filter((c) => visible(c.id)))
    .flatMap((c) => link(c, params, t));

  const accountNode = sitemap.nodes
    .filter((n) => n.placement === "account-menu")
    .flatMap((g) => (g.children ?? []).filter((c) => visible(c.id)))[0];
  const account = accountNode ? (link(accountNode, params, t)[0] ?? null) : null;

  const bottomBar = chromeSlot(sitemap, "mobileBottomBar", nav).flatMap((node): BottomBarItem[] => {
    const icon = NAV_ICONS[node.id] ?? "Circle";
    if (node.id === "action.search")
      return [{ id: node.id, label: t(node.label), icon, action: "search" }];
    if (node.id === "action.menu")
      return [{ id: node.id, label: t(node.label), icon, action: "menu" }];
    return link(node, params, t).map((l) => ({ ...l }));
  });

  const byGroup = new Map<string, CommandGroupModel["items"][number][]>();
  for (const entry of commandMenuIndex(sitemap, { ...nav, knownParams: Object.keys(params) })) {
    // Group by the top-level item (Finance), label by the rest of the trail (Budgets).
    const topNode = getNode(sitemap, entry.id).ancestors.find((a) => a.navigable)?.node;
    const label = t(topNode?.label ?? entry.label);
    const items = byGroup.get(label) ?? [];
    const shortcut = input.hints?.[entry.id];
    items.push({
      label: [...entry.context.slice(1), entry.label].map(t).join(" / "),
      href: fillRoute(entry.route, params),
      icon: NAV_ICONS[topNode?.id ?? entry.id] ?? "Circle",
      ...(shortcut ? { shortcut } : {}),
    });
    byGroup.set(label, items);
  }
  const commands = [...byGroup].map(([label, items]) => ({ label, items }));

  return { top, pinned, groups, footer, account, bottomBar, commands };
}
