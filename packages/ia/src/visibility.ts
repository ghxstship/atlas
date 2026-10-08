import type { Condition, ExternalRoleType, Sitemap, Visibility } from "./schema";
import { indexSitemap, type IndexedNode, type SitemapIndex } from "./tree";

/**
 * Who is looking. `role` is a platform role (Atlas), an account role (Gateway) or a
 * Compass audience. `null` means no session in this shell: anonymous visitors, and
 * external users in Atlas, who see only public and token routes.
 */
export interface NavContext {
  readonly role: string | null;
  readonly conditions?: Iterable<Condition>;
  readonly disabledModules?: Iterable<string>;
  /** Gateway: the role type of the engagement being viewed. */
  readonly roleType?: ExternalRoleType;
  /** Gateway: representation scopes held when acting for an artist. */
  readonly representationScopes?: Iterable<string>;
}

interface RawVisibility {
  readonly value: Visibility;
  readonly declaredBy: IndexedNode;
}

const BILLING_OR_LEGAL = new Set(["billing", "legal"]);

function rawVisibility(
  index: SitemapIndex,
  entry: IndexedNode,
  role: string,
  seen: Set<string>,
): RawVisibility | undefined {
  if (seen.has(entry.node.id)) return undefined;
  seen.add(entry.node.id);
  const { node } = entry;
  if (node.visibility) {
    const value = node.visibility[role];
    return value ? { value, declaredBy: entry } : undefined;
  }
  const ref = node.twin ?? node.visibilityFrom;
  if (ref) {
    const target = index.byId.get(ref);
    if (!target) return undefined;
    const value = resolve(index, target, role, seen);
    return value ? { value, declaredBy: entry } : undefined;
  }
  return entry.parent ? rawVisibility(index, entry.parent, role, seen) : undefined;
}

function resolve(
  index: SitemapIndex,
  entry: IndexedNode,
  role: string,
  seen: Set<string>,
): Visibility | undefined {
  const raw = rawVisibility(index, entry, role, seen);
  if (!raw) return undefined;
  if (raw.value !== "full-except-billing-and-legal" || raw.declaredBy === entry) return raw.value;
  // Inherited compound value: hidden for anything tagged billing or legal below the declarer.
  const chain = [entry, ...[...entry.ancestors].reverse()];
  for (const link of chain) {
    if (link === raw.declaredBy) break;
    if (link.node.tags?.some((t) => BILLING_OR_LEGAL.has(t))) return "hidden";
  }
  return "full";
}

/**
 * The visibility value that applies to a node for a role: its own declaration, else its
 * twin or `visibilityFrom` source, else its nearest ancestor's. Undefined when nothing declares one.
 */
export function effectiveVisibility(
  sitemap: Sitemap,
  id: string,
  role: string,
): Visibility | undefined {
  const index = indexSitemap(sitemap);
  const entry = index.byId.get(id);
  return entry ? resolve(index, entry, role, new Set()) : undefined;
}

/** The value as declared in the sitemap (before compound values resolve per child). */
export function declaredVisibility(
  sitemap: Sitemap,
  id: string,
  role: string,
): Visibility | undefined {
  const index = indexSitemap(sitemap);
  const entry = index.byId.get(id);
  return entry ? rawVisibility(index, entry, role, new Set())?.value : undefined;
}

/** The module key a node belongs to: its own, its twin's, or its nearest ancestor's. */
export function moduleOf(sitemap: Sitemap, id: string): string | undefined {
  const index = indexSitemap(sitemap);
  let entry = index.byId.get(id);
  while (entry) {
    if (entry.node.module) return entry.node.module;
    const twin = entry.node.twin ? index.byId.get(entry.node.twin) : undefined;
    if (twin?.node.module) return twin.node.module;
    entry = entry.parent ?? undefined;
  }
  return undefined;
}

/** Ordered tab ids for an engagement of this role type, narrowed by representation scopes. */
export function engagementTabIds(
  sitemap: Sitemap,
  roleType: ExternalRoleType,
  representationScopes?: Iterable<string>,
): string[] {
  const set = sitemap.engagementTabs?.sets[roleType];
  if (!set) return [];
  if (!("delegatesTo" in set)) return [...set.tabs];
  const delegated = sitemap.engagementTabs?.sets[set.delegatesTo];
  const granted = new Set<string>(set.always);
  for (const scope of representationScopes ?? []) {
    for (const tab of set.scopes[scope] ?? []) granted.add(tab);
  }
  const artistTabs = delegated?.tabs.filter((t) => granted.has(t)) ?? [];
  return [...set.tabs, ...artistTabs];
}

function satisfiesConditions(entry: IndexedNode, ctx: NavContext): boolean {
  const needed = entry.node.conditions ?? [];
  if (needed.length === 0) return true;
  const active = new Set(ctx.conditions ?? []);
  return needed.every((c) => active.has(c));
}

function engagementTabAllowed(sitemap: Sitemap, entry: IndexedNode, ctx: NavContext): boolean {
  const container = sitemap.engagementTabs?.container;
  if (!container || entry.parent?.node.id !== container) return true;
  if (!ctx.roleType) return false;
  return engagementTabIds(sitemap, ctx.roleType, ctx.representationScopes).includes(entry.node.id);
}

function selfRenders(sitemap: Sitemap, index: SitemapIndex, entry: IndexedNode, ctx: NavContext) {
  const auth = entry.node.auth ?? "session";
  if (!satisfiesConditions(entry, ctx)) return false;
  const module = moduleOf(sitemap, entry.node.id);
  if (module && new Set(ctx.disabledModules ?? []).has(module)) return false;
  if (auth !== "session") return true;
  if (ctx.role === null) return false;
  const value = resolve(index, entry, ctx.role, new Set());
  if (value === undefined || value === "hidden") return false;
  return engagementTabAllowed(sitemap, entry, ctx);
}

/**
 * Whether a node renders for this context. A navigable node needs a visible value of its own
 * and every navigable ancestor visible. A group or action renders when any child does, or,
 * for a childless action, when its parent group's role may see the shell at all.
 */
export function isNodeVisible(sitemap: Sitemap, id: string, ctx: NavContext): boolean {
  const index = indexSitemap(sitemap);
  const entry = index.byId.get(id);
  if (!entry) return false;
  if (!entry.navigable) {
    const children = entry.node.children ?? [];
    if (children.length > 0) return children.some((c) => isNodeVisible(sitemap, c.id, ctx));
    if (!satisfiesConditions(entry, ctx)) return false;
    return ctx.role !== null;
  }
  if (!selfRenders(sitemap, index, entry, ctx)) return false;
  return entry.ancestors
    .filter((a) => a.navigable)
    .every((a) => selfRenders(sitemap, index, a, ctx));
}
