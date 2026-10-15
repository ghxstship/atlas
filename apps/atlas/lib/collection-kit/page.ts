import type { ViewKind } from "@/components/collection-kit/types";

/**
 * Collection page state from the URL (Section 11.15: filter, sort and view survive in the URL so a
 * person never loses their place): the view, the peeked row, the full-page flag, the create flow
 * and the calendar month. Shared by every A16 page.
 */

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

export interface CollectionState {
  readonly view: ViewKind;
  readonly peek: string | null;
  readonly full: boolean;
  readonly create: boolean;
  readonly edit: boolean;
  readonly month: string;
  /** The query string without the peek, full, create and edit keys. */
  readonly baseQuery: string;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function collectionState(
  params: SearchParams,
  views: readonly ViewKind[],
  now: Date = new Date(),
): CollectionState {
  const requested = first(params["view"]) as ViewKind | undefined;
  const view = requested && views.includes(requested) ? requested : (views[0] ?? "table");
  const peek = first(params["peek"]);
  const monthParam = first(params["month"]);
  const month =
    monthParam && /^[0-9]{4}-[0-9]{2}$/.test(monthParam)
      ? `${monthParam}-01`
      : `${now.toISOString().slice(0, 7)}-01`;
  const base = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const value = first(v);
    if (value !== undefined && !["peek", "full", "create", "edit"].includes(k)) base.set(k, value);
  }
  return {
    view,
    peek: peek && UUID.test(peek) ? peek : null,
    full: first(params["full"]) === "1",
    create: first(params["create"]) === "1",
    edit: first(params["edit"]) === "1",
    month,
    baseQuery: base.toString(),
  };
}

/** The collection URL with extra query keys, keeping view, search and month. */
export function withQuery(path: string, state: CollectionState, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(state.baseQuery);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Minor units as major units for display components that format currency; null stays null. */
export function toMajor(minor: number | null, exponent = 2): number | null {
  return minor === null ? null : minor / 10 ** exponent;
}

/** Today as YYYY-MM-DD in UTC. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
