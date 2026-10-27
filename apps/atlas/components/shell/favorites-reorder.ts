"use client";

import { reorderFavoritesAction } from "@/lib/settings/favorites-actions";
import type { FavoriteLink, FavoritesReorderState } from "./sidebar-favorites";

/**
 * How the sidebar Favorites move (Section 4.5.2, Section 11.7), loaded the first time someone reaches for a move
 * button or starts a drag, so the shell carries only the list (A24-009). Space picks a favorite up, the arrow keys
 * move it, Space drops it and Esc puts it back; a drop by mouse lands where it falls. Each step is announced, and a
 * drop saves the new order at once (app.reorder_favorites), putting the previous order back if the save fails.
 */

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

function announce(
  s: FavoritesReorderState,
  step: string,
  list: readonly FavoriteLink[],
  index: number,
) {
  s.setAnnouncement(
    s.t(`shell.chrome.favoriteOrder.${step}`, {
      item: list[index]?.label ?? "",
      position: index + 1,
      count: list.length,
    }),
  );
}

function place(s: FavoritesReorderState, next: readonly FavoriteLink[], id: string) {
  s.setItems(next);
  requestAnimationFrame(() => s.handles.current.get(id)?.focus());
}

async function save(
  s: FavoritesReorderState,
  next: readonly FavoriteLink[],
  previous: readonly FavoriteLink[],
) {
  if (sameOrder(next, previous)) return;
  // Only the latest save may put an order back; an older one that fails was already replaced.
  const attempt = ++s.saves.current;
  s.setError(null);
  const result = await reorderFavoritesAction(
    s.org,
    next.map((f) => f.favoriteId),
  ).catch(() => ({ error: "unexpected" }));
  if (!result.error || attempt !== s.saves.current) return;
  s.setItems(previous);
  const message = s.t("shell.chrome.favoriteOrder.failed");
  s.setError(message);
  s.setAnnouncement(message);
}

/** Drops the favorite held by keyboard where it is now. */
export function drop(s: FavoritesReorderState) {
  if (s.held === null) return;
  const index = s.items.findIndex((f) => f.id === s.held?.id);
  s.setHeld(null);
  announce(s, "dropped", s.items, index);
  void save(s, s.items, s.held.order);
}

/** A key on a favorite's move button: Space picks up or drops, the arrows move, Esc puts back. */
export function onKey(s: FavoritesReorderState, key: string, id: string) {
  const index = s.items.findIndex((f) => f.id === id);
  if (key === " ") {
    if (s.held === null) {
      s.setHeld({ id, origin: index, order: s.items });
      announce(s, "picked", s.items, index);
    } else {
      drop(s);
    }
  } else if (s.held?.id === id && (key === "ArrowUp" || key === "ArrowDown")) {
    const to = Math.max(0, Math.min(s.items.length - 1, index + (key === "ArrowUp" ? -1 : 1)));
    const next = moveWithin(s.items, id, to);
    place(s, next, id);
    announce(s, "moved", next, to);
  } else if (s.held?.id === id && key === "Escape") {
    place(s, s.held.order, id);
    s.setHeld(null);
    announce(s, "returned", s.held.order, s.held.origin);
  }
}

/** A favorite dragged by mouse and dropped on the favorite at `index`. */
export function dropDragged(s: FavoritesReorderState, from: string, index: number) {
  const next = moveWithin(s.items, from, index);
  s.setItems(next);
  announce(s, "dropped", next, index);
  void save(s, next, s.items);
}
