import {
  chromeSlot,
  commandMenuIndex,
  fillRoute,
  getNode,
  isNodeVisible,
  routeParams,
  type NavContext,
  type Sitemap,
} from "@xos/ia";

/**
 * The Gateway navigation model for one viewer (Section 4.5.8): the five primary destinations (top
 * bar on desktop, bottom tab bar below md), the avatar menu, the child tabs of each destination and
 * the command menu index. Nothing here is written in a component; it all comes from the sitemap.
 */
export interface NavLink {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
  /** Label keys of the navigable ancestors, for "Settings · Profile" style command entries. */
  readonly context?: readonly string[];
}

export interface AvatarEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly href?: string;
  readonly action?: "switch-org" | "help" | "sign-out";
}

export interface GatewayNav {
  readonly primary: readonly NavLink[];
  readonly bottomBar: readonly NavLink[];
  readonly avatar: readonly AvatarEntry[];
  readonly commands: readonly NavLink[];
}

/** Lucide icons for Gateway destinations, keyed by sitemap node id. */
export const NAV_ICONS: Readonly<Record<string, string>> = {
  home: "House",
  explore: "Compass",
  work: "BriefcaseBusiness",
  money: "Wallet",
  messages: "MessagesSquare",
  profile: "CircleUser",
  documents: "FolderLock",
  settings: "Settings",
  "action.switch-org": "ArrowLeftRight",
  "action.help": "CircleHelp",
  "action.sign-out": "LogOut",
};

function icon(id: string): string {
  return NAV_ICONS[id] ?? NAV_ICONS[id.split(".")[0] ?? ""] ?? "Circle";
}

function link(sitemap: Sitemap, id: string): NavLink | null {
  const node = getNode(sitemap, id).node;
  if (node.route === undefined || routeParams(node.route).length > 0) return null;
  return { id, label: node.label, href: node.route, icon: icon(id) };
}

const ACTIONS: Readonly<Record<string, AvatarEntry["action"]>> = {
  "action.switch-org": "switch-org",
  "action.help": "help",
  "action.sign-out": "sign-out",
};

export function buildNav(sitemap: Sitemap, ctx: NavContext): GatewayNav {
  const links = (slot: string) =>
    chromeSlot(sitemap, slot, ctx).flatMap((n) => {
      const l = link(sitemap, n.id);
      return l ? [l] : [];
    });
  const avatar = chromeSlot(sitemap, "avatarMenu", ctx).map((n): AvatarEntry => {
    const action = ACTIONS[n.id];
    if (action) return { id: n.id, label: n.label, icon: icon(n.id), action };
    return { id: n.id, label: n.label, icon: icon(n.id), href: n.route ?? "/" };
  });
  const commands = commandMenuIndex(sitemap, ctx).map((e) => ({
    id: e.id,
    label: e.label,
    href: fillRoute(e.route, {}),
    icon: icon(e.id),
    context: e.context,
  }));
  return { primary: links("topBar"), bottomBar: links("mobileBottomBar"), avatar, commands };
}

/** Visible child pages of a node, for the page tabs under a destination (Work, Money, Explore). */
export function childTabs(sitemap: Sitemap, id: string, ctx: NavContext): NavLink[] {
  return (getNode(sitemap, id).node.children ?? [])
    .filter((c) => c.kind === "page" && isNodeVisible(sitemap, c.id, ctx))
    .flatMap((c) => {
      const l = link(sitemap, c.id);
      return l ? [l] : [];
    });
}
