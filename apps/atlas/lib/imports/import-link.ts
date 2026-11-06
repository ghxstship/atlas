import { isNodeVisible, type NavContext } from "@xos/ia";
import type { Route } from "next";
import { sitemap } from "@/lib/shell/sitemap";

/** Where an Import cues, Import guests, Import people or Import lines link sends its rows: a running order, a project's guest list, a pool or a budget. */
export type ImportDestination =
  | { readonly target: "cues"; readonly runOfShowId: string }
  | { readonly target: "guest_list_entries"; readonly projectId: string }
  | { readonly target: "pool_invitations"; readonly poolId: string }
  | { readonly target: "budget_lines"; readonly budgetId: string };

/**
 * The import wizard's URL with the target and destination chosen, or null when the link is hidden. It shows only
 * to someone who holds the target's write capability on the destination and may open the import page itself
 * (P3 correction C14): a collaborator, field or viewer role holding the project capability sees no link, since the
 * sitemap hides the import page from them.
 */
export function importLinkHref(
  org: string,
  nav: NavContext,
  canWrite: boolean,
  destination: ImportDestination,
): Route | null {
  if (!canWrite || !isNodeVisible(sitemap, "import", nav)) return null;
  const query =
    destination.target === "cues"
      ? `target=cues&runOfShow=${encodeURIComponent(destination.runOfShowId)}`
      : destination.target === "pool_invitations"
        ? `target=pool_invitations&pool=${encodeURIComponent(destination.poolId)}`
      : destination.target === "budget_lines"
        ? `target=budget_lines&budget=${encodeURIComponent(destination.budgetId)}`
        : `target=guest_list_entries&project=${encodeURIComponent(destination.projectId)}`;
  return `/${org}/import?${query}` as Route;
}
