import type { SitemapNode } from "@xos/ia";

/**
 * A compact form of the client sitemap's routed nodes (ia/sitemap.client.generated.ts), which ships
 * on every signed-in page (ADR 0027, A24-009). Most nodes follow the sitemap's naming rules, so a
 * node is stored as its last id segment and its kind, and its id, label and route are rebuilt:
 *
 * - id: the parent's id, a dot, and the segment (a top-level node's id is the segment);
 * - label: `nav.atlas.<kind>s.` and the id with each segment in camel case;
 * - route: the parent's route (`/{org}` at the top), a slash, and the segment.
 *
 * A node that departs from a rule carries that field in full. Unpacking gives back exactly the
 * nodes that were packed; test/routes.test.ts checks it against the sitemap.
 */
export type PackedNode = [
  segment: string,
  kind: SitemapNode["kind"],
  children?: PackedNode[] | 0,
  label?: string | 0,
  route?: string | 0,
];

const ROOT_ROUTE = "/{org}";
const FULL_ID = "=";

const camel = (segment: string) =>
  segment.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function defaultLabel(id: string, kind: string): string {
  return `nav.atlas.${kind}s.${id.split(".").map(camel).join(".")}`;
}

function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf(".") + 1);
}

export function packNodes(
  nodes: SitemapNode[],
  parentId = "",
  parentRoute = ROOT_ROUTE,
): PackedNode[] {
  return nodes.map((node) => {
    const prefix = parentId ? `${parentId}.` : "";
    const rest = node.id.startsWith(prefix) ? node.id.slice(prefix.length) : null;
    const segment =
      rest !== null && rest !== "" && !rest.includes(".") ? rest : `${FULL_ID}${node.id}`;
    const route = node.route ?? "";
    const packed: PackedNode = [
      segment,
      node.kind,
      node.children && node.children.length > 0 ? packNodes(node.children, node.id, route) : 0,
      node.label === defaultLabel(node.id, node.kind) ? 0 : node.label,
      route === `${parentRoute}/${lastSegment(node.id)}` ? 0 : route,
    ];
    while (packed.length > 2 && packed[packed.length - 1] === 0) packed.pop();
    return packed;
  });
}

export function unpackNodes(
  packed: readonly PackedNode[],
  parentId = "",
  parentRoute = ROOT_ROUTE,
): SitemapNode[] {
  return packed.map(([segment, kind, children, label, route]) => {
    const id = segment.startsWith(FULL_ID)
      ? segment.slice(FULL_ID.length)
      : parentId
        ? `${parentId}.${segment}`
        : segment;
    const ownRoute = route || `${parentRoute}/${lastSegment(id)}`;
    return {
      id,
      kind,
      label: label || defaultLabel(id, kind),
      route: ownRoute,
      ...(children ? { children: unpackNodes(children, id, ownRoute) } : {}),
    };
  });
}
