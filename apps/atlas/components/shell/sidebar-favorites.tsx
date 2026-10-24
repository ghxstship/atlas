"use client";

import { Button, cx, Icon, iconButtonClass, sidebarClass, sidebarItemClass } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { NavLinkModel } from "@/lib/shell/nav-model";
import { reorderFavoritesAction, toggleFavoriteAction } from "@/lib/settings/favorites-actions";

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

function moveWithin(list: readonly FavoriteLink[], id: string, to: number) {
  const from = list.findIndex((f) => f.id === id);
  if (from < 0 || to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as FavoriteLink);
  return next;
}

const sameOrder = (a: readonly FavoriteLink[], b: readonly FavoriteLink[]) =>
  a.length === b.length && a.every((f, i) => f.id === b[i]?.id);

/**
 * The Favorites group of the Atlas sidebar (Section 4.5.2): Pin page and Unpin page for the page the person is on,
 * then their pinned pages and records in their own order. Every favorite moves by drag and by keyboard (Section
 * 11.7): its move button takes Space to pick up, the arrow keys to move, Space to drop and Esc to put back, and a
 * screen reader hears each step. A drop saves the new order at once (app.reorder_favorites) and puts the previous
 * order back if the save fails.
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
  const dragged = useRef<string | null>(null);
  // Only the latest save may put an order back; an older one that fails was already replaced.
  const saves = useRef(0);

  const announce = (step: string, list: readonly FavoriteLink[], index: number) =>
    setAnnouncement(
      t(`shell.chrome.favoriteOrder.${step}`, {
        item: list[index]?.label ?? "",
        position: index + 1,
        count: list.length,
      }),
    );

  const place = (next: readonly FavoriteLink[], id: string) => {
    setItems(next);
    requestAnimationFrame(() => handles.current.get(id)?.focus());
  };

  const save = async (next: readonly FavoriteLink[], previous: readonly FavoriteLink[]) => {
    if (sameOrder(next, previous)) return;
    const attempt = ++saves.current;
    setError(null);
    const result = await reorderFavoritesAction(
      org,
      next.map((f) => f.favoriteId),
    ).catch(() => ({ error: "unexpected" }));
    if (!result.error || attempt !== saves.current) return;
    setItems(previous);
    const message = t("shell.chrome.favoriteOrder.failed");
    setError(message);
    setAnnouncement(message);
  };

  const drop = (hold: Held) => {
    const index = items.findIndex((f) => f.id === hold.id);
    setHeld(null);
    announce("dropped", items, index);
    void save(items, hold.order);
  };

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = items.findIndex((f) => f.id === id);
    if (event.key === " ") {
      event.preventDefault();
      if (held === null) {
        setHeld({ id, origin: index, order: items });
        announce("picked", items, index);
      } else {
        drop(held);
      }
    } else if (held?.id === id && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const to = Math.max(
        0,
        Math.min(items.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)),
      );
      const next = moveWithin(items, id, to);
      place(next, id);
      announce("moved", next, to);
    } else if (held?.id === id && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      place(held.order, id);
      setHeld(null);
      announce("returned", held.order, held.origin);
    }
  };

  const dragProps = (id: string, index: number) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      dragged.current = id;
      event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event: DragEvent<HTMLLIElement>) => {
      if (dragged.current === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      const from = dragged.current;
      if (from === null) return;
      event.preventDefault();
      dragged.current = null;
      const next = moveWithin(items, from, index);
      setItems(next);
      announce("dropped", next, index);
      void save(next, items);
    },
    onDragEnd: () => {
      dragged.current = null;
    },
  });

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
              <li key={f.id} {...dragProps(f.id, index)} className="flex items-center gap-2">
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
                  onKeyDown={(event) => onHandleKey(event, f.id)}
                  onBlur={(event) => {
                    // Moving the list can drop focus for a moment (no related target); leaving for another
                    // control drops the favorite where it is.
                    if (held?.id === f.id && event.relatedTarget !== null) drop(held);
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
