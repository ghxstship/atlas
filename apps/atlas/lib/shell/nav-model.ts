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
 * the always-visible top items, the pinned Projects entry, the module groups with the role's default
 * groups expanded, the footer, the account entry, the phone bottom bar and the command menu index.
 * No navigation item is written in a component; everything here comes from ia/sitemap.yaml.
 */

export interface NavLinkModel {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
}

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
  }[];
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
};

/**
 * Personas whose default expanded groups Section 4.5.2 names, by platform role. A person's persona
 * is not stored yet (person profiles, A30), so the platform role stands in for it.
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

export function buildShellNav(
  sitemap: Sitemap,
  input: {
    readonly nav: NavContext;
    readonly role: SystemRoleCode | null;
    readonly params: Record<string, string>;
    readonly t: Translate;
  },
): ShellNav {
  const { nav, params, t } = input;
  const visible = (id: string) => isNodeVisible(sitemap, id, nav);
  const navigable = (ids: readonly string[]) =>
    ids.filter((id) => getNode(sitemap, id).navigable && visible(id));

  const top = navigable(sitemap.chrome?.["sidebarTop"] ?? []).flatMap((id) =>
    link(getNode(sitemap, id).node, params, t),
  );
  const pinned = navigable(sitemap.chrome?.["sidebarPinned"] ?? []).flatMap((id) =>
    link(getNode(sitemap, id).node, params, t),
  );
  const shownAbove = new Set([...top, ...pinned].map((l) => l.id));
  const persona = input.role ? ROLE_PERSONA[input.role] : null;
  const expanded = new Set(persona ? expandedGroups(sitemap, persona) : []);

  const groups = sitemap.nodes
    .filter((n) => n.placement === "sidebar" && visible(n.id))
    .map((group) => ({
      id: group.id,
      label: t(group.label),
      expanded: expanded.has(group.id),
      items: (group.children ?? [])
        .filter((c) => !shownAbove.has(c.id) && visible(c.id))
        .flatMap((c) => link(c, params, t)),
    }))
    .filter((g) => g.items.length > 0);

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
    items.push({
      label: [...entry.context.slice(1), entry.label].map(t).join(" / "),
      href: fillRoute(entry.route, params),
      icon: NAV_ICONS[topNode?.id ?? entry.id] ?? "Circle",
    });
    byGroup.set(label, items);
  }
  const commands = [...byGroup].map(([label, items]) => ({ label, items }));

  return { top, pinned, groups, footer, account, bottomBar, commands };
}
