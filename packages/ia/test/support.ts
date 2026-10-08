import { getMessages } from "@xos/i18n";
import { loadSitemapFile } from "../src/node.ts";
import type { NavTreeNode } from "../src/helpers.ts";
import type { Sitemap } from "../src/schema.ts";

export const messages = getMessages("en-US");

export function loadApp(app: "atlas" | "gateway" | "compass"): Sitemap {
  return loadSitemapFile(new URL(`../../../apps/${app}/ia/sitemap.yaml`, import.meta.url));
}

export function treeIds(nodes: readonly NavTreeNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...treeIds(n.children)]);
}

export function childIds(sitemap: Sitemap, id: string): string[] {
  const find = (nodes: Sitemap["nodes"]): Sitemap["nodes"][number] | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = find(n.children ?? []);
      if (hit) return hit;
    }
    return undefined;
  };
  return (find(sitemap.nodes)?.children ?? []).map((c) => c.id);
}

export function labelOf(key: string, catalog: unknown = messages): string {
  let cursor: unknown = catalog;
  for (const part of key.split(".")) cursor = (cursor as Record<string, unknown>)[part];
  return String(cursor);
}
