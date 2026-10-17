import type { NodeKind } from "./schema";

/**
 * Runtime constants the navigation helpers need, kept apart from the Zod schema so that a client
 * component using `getNode` or `resolveBreadcrumbs` never bundles Zod or the YAML parser (A24-009).
 */

/** `group` and `action` nodes carry no route and do not count toward navigation depth. */
export const NON_NAVIGABLE_KINDS: ReadonlySet<NodeKind> = new Set(["group", "action"]);

/** Query parameters every list route accepts (Section 4.5.3, route conventions). */
export const LIST_QUERY_PARAMS = ["view", "group", "sort", "filter", "scope"] as const;

/** Typed route parameters. Display keys are uppercase so they never collide with static slugs. */
export const PARAM_TYPES = {
  slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "project-key": /^[A-Z]{2,5}$/,
  "record-key": /^[A-Z]{2,5}-[1-9][0-9]*$/,
  "display-key": /^[A-Z][A-Z0-9]{1,4}(?:-[A-Z0-9]+)+$/,
  handle: /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  token: /^[A-Za-z0-9_-]{16,128}$/,
} as const;
export type ParamType = keyof typeof PARAM_TYPES;
