"use server";

import { addFavorite, listFavorites, removeFavorite } from "@xos/data/settings";
import { guardRoute } from "@xos/ia";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * Pins the page the person is on to their Favorites in this org, or unpins it when it is already
 * there (app.favorites, migration 0850). A page whose route names only the org is pinned as the
 * page; a record open in the side peek (`?peek=<id>`) is pinned with it. Returns a
 * `settings.errors.*` key on refusal.
 */
export async function toggleFavoriteAction(
  orgSlug: string,
  pathname: string,
  peek: string | null,
): Promise<{ readonly pinned?: boolean; readonly error?: string }> {
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return { error: "denied" };
  const match = guardRoute(sitemap, pathname, ctx.nav);
  if (match.status !== 200 || Object.keys(match.params).some((p) => p !== "org")) {
    return { error: "favoriteUnsupported" };
  }
  const target = peek && z.uuid().safeParse(peek).success ? peek : null;
  const personId = ctx.viewer.person.id;
  const favorites = await listFavorites(ctx.viewer.db, { orgId: ctx.org.id, personId });
  if (!favorites.ok) return { error: "unexpected" };
  const existing = favorites.data.find((f) => f.nodeId === match.id && f.targetId === target);
  const result = existing
    ? await removeFavorite(ctx.viewer.db, existing.id)
    : await addFavorite(ctx.viewer.db, {
        orgId: ctx.org.id,
        personId,
        nodeId: match.id,
        targetId: target,
        sortOrder: favorites.data.length,
      });
  if (!result.ok) {
    return {
      error:
        result.error.kind === "refusal" && result.error.rule === "favorites_limit"
          ? "favorites_limit"
          : "unexpected",
    };
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { pinned: !existing };
}
