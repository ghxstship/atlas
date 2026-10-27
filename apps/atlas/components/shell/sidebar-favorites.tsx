"use client";

import { Button, cx, Icon, iconButtonClass, sidebarClass, sidebarItemClass } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRef, useState, type MouseEvent } from "react";
import type { NavLinkModel } from "@/lib/shell/nav-model";
import { toggleFavoriteAction } from "@/lib/settings/favorites-actions";
import type * as Reorder from "./favorites-reorder";
import { onDemand } from "./on-demand";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A favorite as the sidebar lists it: its link and the app.favorites row it stands for. */
export interface FavoriteLink extends NavLinkModel {
  readonly favoriteId: string;
}

/** A favorite held by keyboard, with the order it was picked up from, so Esc can put it back. */
interface Held {
  readonly id: string;
  readonly origin: number;
  readonly order: readonly FavoriteLink[];
}

/** What the reorder module (favorites-reorder.ts) reads and sets, current as of the last render. */
export interface FavoritesReorderState {
  readonly org: string;
  readonly t: Translate;
  readonly items: readonly FavoriteLink[];
  readonly held: Held | null;
  readonly setItems: (items: readonly FavoriteLink[]) => void;
  readonly setHeld: (held: Held | null) => void;
  readonly setAnnouncement: (text: string) => void;
  readonly setError: (error: string | null) => void;
  readonly handles: { readonly current: Map<string, HTMLButtonElement> };
  readonly saves: { current: number };
}

/** How favorites move loads the first time someone reaches for a move button or starts a drag (A24-009). */
const reorder = onDemand(() => import("./favorites-reorder"));

/**
 * The Favorites group of the Atlas sidebar (Section 4.5.2): Pin page and Unpin page for the page the person is on,
 * then their pinned pages and records in their own order. Every favorite moves by drag and by keyboard (Section
 * 11.7): its move button takes Space to pick up, the arrow keys to move, Space to drop and Esc to put back, and a
 * screen reader hears each step. A drop saves the new order at once (app.reorder_favorites) and puts the previous
 * order back if the save fails. The moving itself is favorites-reorder.ts, fetched when first needed.
 */
export function SidebarFavorites({
  org,
  pathname,
  favorites,
  active,
  go,
}: {
  readonly org: string;
  readonly pathname: string;
  /** The person's favorites in this org, in their order (app.favorites). */
  readonly favorites: readonly FavoriteLink[];
  /** The label of the sidebar item for the current page. */
  readonly active?: string;
  /** Client-side navigation. */
  readonly go: (href: string) => void;
}) {
  const t = useTranslations() as unknown as Translate;
  const [items, setItems] = useState(favorites);
  // Pinning or unpinning renders the shell again with the server's list; take it.
  const [source, setSource] = useState(favorites);
  if (source !== favorites) {
    setSource(favorites);
    setItems(favorites);
  }
  const [held, setHeld] = useState<Held | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const saves = useRef(0);
  const dragged = useRef<string | null>(null);
  const state: FavoritesReorderState = {
    org,
    t,
    items,
    held,
    setItems,
    setHeld,
    setAnnouncement,
    setError,
    handles,
    saves,
  };
  /** Runs a step of the reorder module on this render's state, at once when the module has loaded. */
  const run = (step: (m: typeof Reorder, s: FavoritesReorderState) => void) => {
    const loaded = reorder.current();
    if (loaded) return step(loaded, state);
    reorder.load().then(
      (m) => step(m, state),
      (failure: unknown) => console.error("Could not load the favorites reorder", failure),
    );
  };

  const pinned = items.some((f) => f.href.split("?")[0] === pathname);

  return (
    <>
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
            {pinned ? t("settings.favorites.unpin") : t("settings.favorites.pin")}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="m-0 mt-4 text-text-12 text-danger-text">
            {error}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="m-0 mt-4 text-text-12 text-text-tertiary">
            {t("shell.chrome.favoritesEmpty")}
          </p>
        ) : null}
      </section>
      {items.length > 0 ? (
        <nav aria-label={t("nav.atlas.actions.favorites")} className={sidebarClass}>
          <p id="favorites-move-help" className="sr-only">
            {t("shell.chrome.favoriteOrder.moveHelp")}
          </p>
          <ol className="m-0 p-0 list-none">
            {items.map((f, index) => (
              <li
                key={f.id}
                draggable
                onDragStart={(event) => {
                  dragged.current = f.id;
                  event.dataTransfer.effectAllowed = "move";
                  void reorder.load();
                }}
                onDragOver={(event) => {
                  if (dragged.current === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  const from = dragged.current;
                  if (from === null) return;
                  event.preventDefault();
                  dragged.current = null;
                  run((m, s) => m.dropDragged(s, from, index));
                }}
                onDragEnd={() => {
                  dragged.current = null;
                }}
                className="flex items-center gap-2"
              >
                <a
                  href={f.href}
                  aria-current={f.label === active ? "page" : undefined}
                  className={cx(sidebarItemClass, "min-w-0 flex-1")}
                  onClick={(event: MouseEvent) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    go(f.href);
                  }}
                >
                  <Icon name={f.icon} />
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                </a>
                <button
                  type="button"
                  ref={(el) => {
                    if (el) handles.current.set(f.id, el);
                    else handles.current.delete(f.id);
                  }}
                  aria-label={t("shell.chrome.favoriteOrder.move", { item: f.label })}
                  title={t("shell.chrome.favoriteOrder.move", { item: f.label })}
                  aria-describedby="favorites-move-help"
                  aria-pressed={held?.id === f.id}
                  onFocus={() => void reorder.load()}
                  onPointerEnter={() => void reorder.load()}
                  onKeyDown={(event) => {
                    const key = event.key;
                    if (
                      key !== " " &&
                      (held?.id !== f.id || !/^(ArrowUp|ArrowDown|Escape)$/.test(key))
                    ) {
                      return;
                    }
                    event.preventDefault();
                    // Esc puts the favorite back without closing anything around the sidebar.
                    if (key === "Escape") event.stopPropagation();
                    run((m, s) => m.onKey(s, key, f.id));
                  }}
                  onBlur={(event) => {
                    // Moving the list can drop focus for a moment (no related target); leaving for another
                    // control drops the favorite where it is.
                    if (held?.id === f.id && event.relatedTarget !== null) run((m, s) => m.drop(s));
                  }}
                  className={cx(
                    iconButtonClass("ghost"),
                    "shrink-0 cursor-grab aria-pressed:bg-bg-hover aria-pressed:text-text-primary",
                  )}
                >
                  <Icon name="GripVertical" size={14} />
                </button>
              </li>
            ))}
          </ol>
          <span aria-live="assertive" className="sr-only">
            {announcement}
          </span>
        </nav>
      ) : null}
    </>
  );
}
