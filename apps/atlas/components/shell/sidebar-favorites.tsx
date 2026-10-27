"use client";

import { Button, Sidebar, type NavItem } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState, type FocusEvent } from "react";
import type { NavLinkModel } from "@/lib/shell/nav-model";
import { toggleFavoriteAction } from "@/lib/settings/favorites-actions";
import { onDemand, useOnDemand } from "./on-demand";

/** A favorite as the sidebar lists it: its link and the app.favorites row it stands for. */
export interface FavoriteLink extends NavLinkModel {
  readonly favoriteId: string;
}

/** The Favorites that move load the first time the pointer or focus reaches the Favorites (A24-009). */
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
  // Null until the pointer or focus reaches the Favorites; then the address of the favorite focused, if any.
  const [reached, setReached] = useState<{ readonly focus: string | null } | null>(null);
  const loaded = useOnDemand(reorder, reached !== null);
  const reach = (event?: FocusEvent) => {
    if (reached === null) {
      setReached({
        focus: (event?.target as HTMLElement | undefined)?.getAttribute("href") ?? null,
      });
    }
  };

  return (
    // The sidebar's own column and spacing (packages/ui AppShell), as if the two parts sat in it directly.
    <div className="flex flex-col gap-4" onPointerEnter={() => reach()} onFocus={reach}>
      <section aria-labelledby="favorites-heading" className="px-8">
        <div className="flex items-center justify-between gap-8">
          <h2 id="favorites-heading" className="m-0 text-text-11 font-medium text-text-secondary">
            {t("nav.atlas.actions.favorites")}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const peek = new URLSearchParams(window.location.search).get("peek");
              const result = await toggleFavoriteAction(org, pathname, peek);
              setError(result.error ? t(`settings.errors.${result.error}`) : null);
            }}
          >
            {favorites.some((f) => f.href.split("?")[0] === pathname)
              ? t("settings.favorites.unpin")
              : t("settings.favorites.pin")}
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
