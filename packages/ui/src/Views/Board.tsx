import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from "react";
import { Direction } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { isMenuKey, useItemSelection } from "../lib/selection.ts";
import { Icon } from "../Icon/Icon.tsx";
import { buttonClass } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { PropertyChip, RecordKindChip } from "../Chips/Chips.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { ScrollRegion } from "../Layout/ScrollRegion.tsx";
import { type BoardProps, type Card } from "./Views.types.ts";

/** How the selection and menus name a card. */
const idOf = (card: Card) => card.id ?? card.key;

/**
 * Records grouped into columns by state. Cards move by drag or by keyboard: Space picks a card up,
 * Arrow Left and Right carry it across columns, Space drops it and Esc puts it back. With
 * `selection`, cards select as rows of a list do (X and Shift+X, Cmd or Ctrl+click, Shift+click,
 * Cmd or Ctrl+A, Esc), in reading order down each column. Right-click, Shift+F10 or the Context Menu
 * key on a card calls `onItemContextMenu`. A card's key and title carry `data-column`, and the card
 * its `data-item` id, so a page can preview them (hover cards).
 */
export function Board({
  addLabel,
  readOnly = false,
  columns,
  selection,
  onItemContextMenu,
  onMove,
  onAdd,
  onOpen,
}: BoardProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const dir = Direction.useDirection();
  const [cols, setCols] = useState(columns);
  const [held, setHeld] = useState<{ key: string; origin: number; at: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const ids = () => cols.flatMap((col) => col.cards.map(idOf));
  const select = useItemSelection(selection, ids);
  const selectedCount = selection ? ids().filter(select.isSelected).length : 0;

  const move = (key: string, from: number, to: number) => {
    if (from === to) return;
    setCols((current) => {
      const card = current[from]?.cards.find((c) => c.key === key);
      if (!card) return current;
      return current.map((col, i) =>
        i === from
          ? { ...col, cards: col.cards.filter((c) => c.key !== key) }
          : i === to
            ? { ...col, cards: [...col.cards, card] }
            : col,
      );
    });
    requestAnimationFrame(() => cardRefs.current.get(key)?.focus());
  };

  const onCardKey = (e: KeyboardEvent<HTMLElement>, card: Card, colIndex: number) => {
    if (held === null && e.target === e.currentTarget) {
      if (onItemContextMenu && isMenuKey(e)) {
        e.preventDefault();
        onItemContextMenu(idOf(card), null, e.currentTarget);
        return;
      }
      if (select.onKey(e, idOf(card))) return;
    }
    if (readOnly) {
      if (e.key === "Enter") onOpen?.(card.key);
      return;
    }
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    if (e.key === " ") {
      e.preventDefault();
      if (held === null) {
        setHeld({ key: card.key, origin: colIndex, at: colIndex });
        setAnnouncement(
          t("board.picked", { title: card.title, column: cols[colIndex]?.label ?? "" }),
        );
      } else {
        const from = cols[held.origin]?.state;
        const to = cols[held.at]?.state;
        if (from && to && held.origin !== held.at) onMove?.(held.key, from, to);
        setAnnouncement(
          t("board.dropped", { title: card.title, column: cols[held.at]?.label ?? "" }),
        );
        setHeld(null);
      }
    } else if (held && (e.key === forward || e.key === back)) {
      e.preventDefault();
      const to = Math.max(0, Math.min(cols.length - 1, held.at + (e.key === forward ? 1 : -1)));
      move(held.key, held.at, to);
      setHeld({ ...held, at: to });
      setAnnouncement(t("board.moved", { title: card.title, column: cols[to]?.label ?? "" }));
    } else if (held && e.key === "Escape") {
      e.preventDefault();
      move(held.key, held.at, held.origin);
      setAnnouncement(
        t("board.returned", { title: card.title, column: cols[held.origin]?.label ?? "" }),
      );
      setHeld(null);
    } else if (e.key === "Enter" && !held) {
      onOpen?.(card.key);
    }
  };

  const onDrop = (e: DragEvent<HTMLElement>, to: number) => {
    e.preventDefault();
    const [key, fromText] = e.dataTransfer.getData("text/plain").split("|");
    const from = Number(fromText);
    if (!key || Number.isNaN(from)) return;
    move(key, from, to);
    const fromState = cols[from]?.state;
    const toState = cols[to]?.state;
    if (fromState && toState && from !== to) onMove?.(key, fromState, toState);
  };

  // Columns that do not fit scroll sideways in a region whose cut-off edge fades (A59-012).
  return (
    <ScrollRegion label={t("scroll.region")}>
      <div className="flex items-start gap-12 w-max min-w-full">
        {cols.map((col, ci) => (
          <section
            key={col.state}
            aria-label={col.label}
            onDragOver={readOnly ? undefined : (e) => e.preventDefault()}
            onDrop={readOnly ? undefined : (e) => onDrop(e, ci)}
            className="flex flex-none flex-col gap-8 w-(--ui-board-col) p-8 rounded-card bg-bg-surface"
          >
            <header className="flex items-center gap-6 p-4">
              <StateIcon state={col.state} />
              <h2 className="m-0 text-text-13 font-semibold">{col.label}</h2>
              <span className="text-text-secondary tabular-nums">{col.cards.length}</span>
            </header>
            {col.cards.map((card) => {
              const selected = select.isSelected(idOf(card));
              return (
                <div
                  key={card.key}
                  ref={(el) => {
                    if (el) cardRefs.current.set(card.key, el);
                    else cardRefs.current.delete(card.key);
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={held?.key === card.key ? true : undefined}
                  data-item={idOf(card)}
                  data-selected={selected ? "" : undefined}
                  draggable={!readOnly}
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", `${card.key}|${ci}`)}
                  onKeyDown={(e) => onCardKey(e, card, ci)}
                  onDoubleClick={() => onOpen?.(card.key)}
                  {...(selection
                    ? {
                        onClick: (e) => select.onClick(e, idOf(card)),
                        onMouseDown: (e) => {
                          // Shift+click selects a range, not the text between.
                          if (e.shiftKey) e.preventDefault();
                        },
                      }
                    : {})}
                  {...(onItemContextMenu
                    ? {
                        onContextMenu: (e) => {
                          e.preventDefault();
                          onItemContextMenu(
                            idOf(card),
                            { x: e.clientX, y: e.clientY },
                            e.currentTarget,
                          );
                        },
                      }
                    : {})}
                  className={cx(
                    "flex flex-col gap-8 p-12 rounded-card border border-border-subtle bg-bg-raised",
                    "hover:border-border-strong aria-pressed:border-accent aria-pressed:ring-(length:--stroke-width-focus) aria-pressed:ring-accent",
                    "data-selected:border-accent data-selected:bg-bg-hover",
                    readOnly ? "cursor-pointer" : "cursor-grab",
                    "forced-colors:border-[CanvasText]",
                  )}
                >
                  <div className="flex items-center justify-between gap-6">
                    <span data-column="key" className="font-mono text-text-12 text-text-secondary">
                      {card.key}
                    </span>
                    {card.owner ? <Avatar name={card.owner} /> : null}
                  </div>
                  <span data-column="title">{card.title}</span>
                  {selected ? <span className="sr-only">{t("bulk.itemSelected")}</span> : null}
                  {card.meta ? (
                    <span className="text-text-12 text-text-secondary">{card.meta}</span>
                  ) : null}
                  {card.kind || card.due ? (
                    <div className="flex flex-wrap items-center gap-4">
                      {card.kind ? <RecordKindChip kind={card.kind} /> : null}
                      {card.due ? <PropertyChip icon="Calendar" value={card.due} /> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => onAdd?.(col.state)}
                className={cx(buttonClass("ghost"), "justify-start")}
              >
                <Icon name="Plus" size={14} />
                {addLabel ?? t("board.add")}
              </button>
            )}
          </section>
        ))}
      </div>
      <span aria-live="assertive" className="sr-only">
        {announcement}
      </span>
      {selection ? (
        <span role="status" className="sr-only">
          {selectedCount > 0 ? t("bulk.selected", { n: fmt.number(selectedCount) }) : ""}
        </span>
      ) : null}
    </ScrollRegion>
  );
}
