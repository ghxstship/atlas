import type { OrgContext } from "@/lib/shell/context";

/**
 * Test support for pages and actions that date things on the org's own calendar (A71, RRR-116): a viewer's
 * client over stored settings, an org context around it, and a reader for a server component's element tree.
 */

export type Settings = Record<string, string>;

/**
 * A viewer's client over stored settings: `org` holds the values the org set at its own scope and `member`
 * the viewer's own. resolve_settings answers as the database does for this viewer, with their own value
 * first; reading setting_values at the Organization scope answers only the org's row. `rows` answers other
 * tables' lists by name.
 */
export function viewerDb(
  org: Settings,
  member: Settings,
  rows: Record<string, Record<string, unknown>[]> = {},
) {
  const row = (value: string) => ({ value_text: value, value_boolean: null, value_integer: null });
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        is: () => builder,
        order: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
        maybeSingle: () => {
          const atOrg =
            table === "setting_values" &&
            filters["scope_kind"] === "Organization" &&
            filters["scope_id"] === filters["org_id"];
          const value = atOrg ? org[String(filters["setting_key"])] : undefined;
          return Promise.resolve({ data: value === undefined ? null : row(value), error: null });
        },
      };
      return builder;
    },
    rpc(fn: string) {
      if (fn !== "resolve_settings") {
        return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
      }
      const resolved = { ...org, ...member };
      return Promise.resolve({
        data: Object.entries(resolved).map(([key, value]) => ({
          setting_key: key,
          ...row(value),
          source: key in member ? "Personal" : "Organization",
          locked: false,
        })),
        error: null,
      });
    },
  };
}

/** An org context for the viewer's client, holding `capabilities`. */
export function context(db: ReturnType<typeof viewerDb>, capabilities: string[]): OrgContext {
  return {
    viewer: {
      db,
      userId: "user-1",
      email: "alice@example.test",
      person: { id: "person-1", fullName: "Alice Morgan" },
    },
    org: { id: "org-1", slug: "northwind", name: "Northwind" },
    capabilities: new Set(capabilities),
  } as unknown as OrgContext;
}

export interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

/** Every element in a rendered tree (components are not called, so their props show what they get). */
export function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props["children"])];
}
