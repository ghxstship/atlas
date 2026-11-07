"use client";

import { Button, Sidebar, sidebarClass, sidebarItemClass, type NavItem } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition, type FocusEvent } from "react";
import type { NavLinkModel } from "@/lib/shell/nav-model";
import { onDemand, useOnDemand } from "./on-demand";

/** A favorite as the sidebar lists it: its link and the app.favorites row it stands for. */
export interface FavoriteLink extends NavLinkModel {
  readonly favoriteId: string;
}

/**
 * The Favorites that move, and pinning, load the first time the pointer or focus reaches the Favorites (A24-009).
 */
const reorder = onDemand(() => import("./favorites-reorder"));

/**
 * The Favorites group of the Atlas sidebar (Section 4.5.2): Pin page and Unpin page for the page the person is on,
 * then their pinned pages and records in their own order. The list renders plain; when the pointer or focus first
 * reaches the Favorites, favorites-reorder.tsx takes its place, where each favorite moves by drag and by keyboard
 * (Section 11.7).
 */
export function SidebarFavorites({
  org,
  pathname,
  favorites,
  active,
  go,
  toItem,
}: {
  readonly org: string;
  readonly pathname: string;
  /** The person's favorites in this org, in their order (app.favorites). */
  readonly favorites: readonly FavoriteLink[];
  /** The label of the sidebar item for the current page. */
  readonly active?: string;
  /** Client-side navigation. */
  readonly go: (href: string) => void;
  /** A sidebar item for a link, navigating client side. */
  readonly toItem: (l: NavLinkModel) => NavItem;
}) {
  const t = useTranslations() as unknown as (key: string) => string;
  const [error, setError] = useState<string | null>(null);
  // Pin page and Unpin page answer at once (Section 11.10 rule 9); the refreshed Favorites confirm it. A press flips
  // what the button shows, so a second press before the first answer undoes it, as the label says: the server
  // actions run one after another, and the second toggle reads the first one's result.
  const pinnedHere = favorites.some((f) => f.href.split("?")[0] === pathname);
  const [pinned, setPinned] = useOptimistic(pinnedHere);
  const [, startPin] = useTransition();
  // Null until the pointer or focus reaches the Favorites; then the address of the favorite focused, if any, kept
  // up to date until the list that moves takes over, so the favorite focused at that moment keeps the focus.
  const [reached, setReached] = useState<{ readonly focus: string | null } | null>(null);
  const loaded = useOnDemand(reorder, reached !== null);
  const point = () => {
    if (reached === null) setReached({ focus: null });
  };
  const reach = (event: FocusEvent) => {
    if (loaded && reached) return;
    const focus = (event.target as HTMLElement).getAttribute("href");
    if (reached?.focus !== focus) setReached({ focus });
  };

  return (
    // The sidebar's own column and spacing (packages/ui AppShell), as if the two parts sat in it directly.
    <div className="flex flex-col gap-4" onPointerEnter={point} onFocus={reach}>
      <section aria-labelledby="favorites-heading" className="px-8">
        <div className="flex items-center justify-between gap-8">
          <h2 id="favorites-heading" className="m-0 text-text-11 font-medium text-text-secondary">
            {t("nav.atlas.actions.favorites")}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              startPin(async () => {
                setPinned(!pinned);
                const peek = new URLSearchParams(window.location.search).get("peek");
                const result = await (await reorder.load()).toggleFavorite(org, pathname, peek);
                setError(result.error ? t(`settings.errors.${result.error}`) : null);
              })
            }
          >
            {pinned ? t("settings.favorites.unpin") : t("settings.favorites.pin")}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="m-0 mt-4 text-text-12 text-danger-text">
            {error}
          </p>
        ) : null}
        {favorites.length === 0 ? (
          <p className="m-0 mt-4 text-text-12 text-text-tertiary">
            {t("shell.chrome.favoritesEmpty")}
          </p>
        ) : null}
      </section>
      {favorites.length === 0 ? null : loaded && reached ? (
        <loaded.ReorderableFavorites
          org={org}
          favorites={favorites}
          {...(active ? { active } : {})}
          go={go}
          focus={reached.focus}
          onError={setError}
          frameClass={sidebarClass}
          itemClass={sidebarItemClass}
        />
      ) : (
        <Sidebar
          label={t("nav.atlas.actions.favorites")}
          {...(active ? { active } : {})}
          groups={[{ items: favorites.map(toItem) }]}
        />
      )}
    </div>
  );
}
