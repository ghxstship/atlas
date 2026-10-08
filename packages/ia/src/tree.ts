import { NON_NAVIGABLE_KINDS, type Sitemap, type SitemapNode } from "./schema";

/** A node with its position in the tree. */
export interface IndexedNode {
  readonly node: SitemapNode;
  readonly parent: IndexedNode | null;
  /** Ancestors from the root down to the parent. */
  readonly ancestors: readonly IndexedNode[];
  /** Whether the node is a navigation step (has a route; not a group or action). */
  readonly navigable: boolean;
  /**
   * Navigation steps from Home (gate 25). Home is 0. Groups and actions are disclosure,
   * not navigation, so they add no depth; any other node is one step below its nearest
   * navigable ancestor, or one step from Home when it has none (always-visible chrome).
   */
  readonly depth: number;
}

export interface SitemapIndex {
  readonly sitemap: Sitemap;
  readonly byId: ReadonlyMap<string, IndexedNode>;
  /** Every node in declared (pre-order) order. */
  readonly order: readonly IndexedNode[];
  /** Ids declared more than once, in order of the repeat. */
  readonly duplicateIds: readonly string[];
}

const cache = new WeakMap<Sitemap, SitemapIndex>();

export function isNavigable(node: SitemapNode): boolean {
  return !NON_NAVIGABLE_KINDS.has(node.kind);
}

/** Index a sitemap once; later calls with the same object reuse the index. */
export function indexSitemap(sitemap: Sitemap): SitemapIndex {
  const cached = cache.get(sitemap);
  if (cached) return cached;

  const byId = new Map<string, IndexedNode>();
  const order: IndexedNode[] = [];
  const duplicateIds: string[] = [];

  const visit = (node: SitemapNode, parent: IndexedNode | null): void => {
    const ancestors = parent ? [...parent.ancestors, parent] : [];
    const navigable = isNavigable(node);
    const nearest = [...ancestors].reverse().find((a) => a.navigable);
    const depth = node.id === sitemap.home ? 0 : nearest ? nearest.depth + 1 : 1;
    const entry: IndexedNode = { node, parent, ancestors, navigable, depth };
    if (byId.has(node.id)) duplicateIds.push(node.id);
    else byId.set(node.id, entry);
    order.push(entry);
    for (const child of node.children ?? []) visit(child, entry);
  };
  for (const node of sitemap.nodes) visit(node, null);

  const index: SitemapIndex = { sitemap, byId, order, duplicateIds };
  cache.set(sitemap, index);
  return index;
}

/** Look up a node by id; throws for an unknown id. */
export function getNode(sitemap: Sitemap, id: string): IndexedNode {
  const entry = indexSitemap(sitemap).byId.get(id);
  if (!entry) throw new Error(`unknown sitemap node "${id}" in the ${sitemap.shell} sitemap`);
  return entry;
}
