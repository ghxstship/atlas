/**
 * The view registry model (Section 11.15). A view type needs data traits; a page offers the views it
 * declares whose traits its data has. Pure functions only, so browsers and servers share them.
 */

export const SHELLS = ["atlas", "gateway", "compass"] as const;
export type Shell = (typeof SHELLS)[number];

/** The app.view_type labels a saved view stores (migrations 0540 and 0640). */
export const SAVED_VIEW_TYPES = [
  "List",
  "Board",
  "Table",
  "Calendar",
  "Timeline",
  "Spreadsheet",
  "Gallery",
  "Resource Schedule",
  "Map",
  "Site Plan",
  "Tree",
  "Matrix",
  "Org Chart",
  "Chart",
  "Feed",
  "Inbox",
] as const;
export type SavedViewType = (typeof SAVED_VIEW_TYPES)[number];

export interface ViewTrait {
  readonly code: string;
  readonly description: string;
}

export interface ViewDefinition {
  /** The view's code, as page query strings and sitemap nodes name it (`view=board`). */
  readonly code: string;
  readonly savedAs: SavedViewType;
  /** lucide-react icon name. */
  readonly icon: string;
  /** Every trait the data must have for the view to be offered. */
  readonly requires: readonly string[];
  readonly shells: readonly Shell[];
  /** True for visual layouts that render an accessible table alternative. */
  readonly alternative: boolean;
}

export interface EntityDefault {
  readonly entity: string;
  /** Default view code per shell or context (atlas, gateway, compass, dispatch). */
  readonly views: Readonly<Record<string, string>>;
}

export interface ViewRegistry {
  readonly traits: readonly ViewTrait[];
  readonly views: readonly ViewDefinition[];
  readonly defaults: readonly EntityDefault[];
}

/** Whether a data set with these traits qualifies for a view. */
export function fits(
  view: ViewDefinition,
  traits: ReadonlySet<string> | readonly string[],
): boolean {
  const have = traits instanceof Set ? traits : new Set(traits);
  return view.requires.every((t) => have.has(t));
}

/**
 * The views to offer, in the declared order: declared by the page, known to the registry, offered in
 * the shell and fitting the data. Unknown codes are dropped, never offered disabled.
 */
export function offeredViews(
  registry: ViewRegistry,
  options: {
    readonly declared: readonly string[];
    readonly shell: Shell;
    readonly traits?: ReadonlySet<string> | readonly string[];
  },
): ViewDefinition[] {
  const byCode = new Map(registry.views.map((v) => [v.code, v]));
  return options.declared.flatMap((code) => {
    const view = byCode.get(code);
    if (!view || !view.shells.includes(options.shell)) return [];
    if (options.traits !== undefined && !fits(view, options.traits)) return [];
    return [view];
  });
}

/** The default view of an entity in a shell or context, when the registry names one. */
export function entityDefault(
  registry: ViewRegistry,
  entity: string,
  context: string,
): string | undefined {
  return registry.defaults.find((d) => d.entity === entity)?.views[context];
}

/** The saved view type a view code stores, or undefined for an unknown code. */
export function savedViewTypeOf(registry: ViewRegistry, code: string): SavedViewType | undefined {
  return registry.views.find((v) => v.code === code)?.savedAs;
}

/** The first view code that saves as a type, used when a saved view is opened. */
export function viewCodeOf(
  registry: ViewRegistry,
  savedAs: SavedViewType,
  among?: readonly string[],
): string | undefined {
  const pool = among ? registry.views.filter((v) => among.includes(v.code)) : registry.views;
  return pool.find((v) => v.savedAs === savedAs)?.code;
}
