import {
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { Direction, Toolbar as RToolbar } from "radix-ui";
import type {
  ActivityFeedItemProps as ReferenceActivityFeedItemProps,
  BoardProps as ReferenceBoardProps,
  BulkActionBarProps as ReferenceBulkActionBarProps,
  RecordListProps as ReferenceRecordListProps,
  RecordRowProps as ReferenceRecordRowProps,
  RecordState,
  StatTileProps as ReferenceStatTileProps,
  TreeNode as ReferenceTreeNode,
  TreeViewProps as ReferenceTreeViewProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { rovingIndex } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button, buttonClass, iconButtonClass } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { PropertyChip, RecordKindChip, chipClass } from "../Chips/Chips.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { Money } from "../Forms/Forms.tsx";

export type RecordRowProps = ReferenceRecordRowProps & {
  /** X toggles selection of the focused row. */
  onSelect?: () => void;
  /** Enter opens the record. */
  onOpen?: () => void;
};
export type RecordListProps = ReferenceRecordListProps;
export type BoardProps = ReferenceBoardProps & {
  /** Called after a card moves to another column by drag or keyboard. */
  onMove?: (cardKey: string, from: RecordState, to: RecordState) => void;
  onAdd?: (state: RecordState) => void;
  onOpen?: (cardKey: string) => void;
};
export interface TreeNode extends ReferenceTreeNode {
  children?: TreeNode[];
  /** Stable id; the label path by default. */
  id?: string;
}
export type TreeViewProps = Omit<ReferenceTreeViewProps, "nodes"> & {
  nodes: TreeNode[];
  onSelect?: (node: TreeNode) => void;
};
export type BulkActionBarProps = Omit<ReferenceBulkActionBarProps, "actions"> & {
  actions: { label: string; icon?: string; shortcut?: string; onSelect?: () => void }[];
  onClear?: () => void;
  onMore?: () => void;
};
export type ActivityFeedItemProps = ReferenceActivityFeedItemProps & {
  onReact?: (label: string) => void;
};
export type StatTileProps = ReferenceStatTileProps & { onDrill?: () => void };

/** One list row that answers what now: state, key, title, chips, next date, owner and the next action. */
export function RecordRow({
  state,
  stateLabel,
  recordKey,
  kind,
  title,
  chips,
  next,
  owner,
  actionLabel,
  actionKey,
  selected,
  onAction,
  onSelect,
  onOpen,
}: RecordRowProps): ReactElement {
  return (
    <div
      role="row"
      aria-selected={selected ?? undefined}
      tabIndex={-1}
      data-row
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key.toLowerCase() === "x" && onSelect) {
          e.preventDefault();
          onSelect();
        } else if (e.key === "Enter" && onOpen) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cx(
        "xos-rrow border-b border-border-subtle last:border-b-0 outline-none",
        "hover:bg-bg-hover focus-visible:bg-bg-hover aria-selected:bg-bg-hover",
        "focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-inset focus-visible:ring-focus-ring",
      )}
    >
      <span role="gridcell" className="inline-flex">
        <StateIcon state={state} />
        <span className="sr-only">{stateLabel}</span>
      </span>
      <span role="gridcell" className="font-mono text-text-12 text-text-secondary">
        {recordKey}
      </span>
      <span role="gridcell" className="flex items-center gap-6 min-w-0">
        {kind ? (
          <RecordKindGlyph kind={kind} size={14} color="var(--color-text-secondary)" />
        ) : null}
        <span className="truncate">{title}</span>
      </span>
      <span role="gridcell" className="flex gap-4">
        {chips}
      </span>
      <span
        role="gridcell"
        className="flex items-center gap-4 text-text-12 text-text-secondary tabular-nums whitespace-nowrap"
      >
        {next ? (
          <>
            <Icon name="Calendar" size={14} />
            {next}
          </>
        ) : null}
      </span>
      <span role="gridcell">{owner ? <Avatar name={owner} /> : null}</span>
      <span role="gridcell" className="xos-rrow-action flex justify-end">
        {actionLabel ? (
          <Button size="sm" onClick={onAction} {...(actionKey ? { shortcut: actionKey } : {})}>
            {actionLabel}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The list of RecordRows with the grid role and the list's name. Arrow Up and Down, J and K move
 * between rows; Home and End jump.
 */
export function RecordList({ label, children }: RecordListProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const rowsOf = () => [...(ref.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = rowsOf();
    const index = rows.findIndex((r) => r.contains(document.activeElement));
    const key = e.key === "j" ? "ArrowDown" : e.key === "k" ? "ArrowUp" : e.key;
    const next = rovingIndex(key, Math.max(0, index), rows.length, "vertical");
    if (next === null || rows.length === 0) return;
    if (index === -1 && key !== "Home" && key !== "End") return;
    e.preventDefault();
    rows[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role="grid"
      aria-label={label}
      tabIndex={entered ? -1 : 0}
      onFocus={(e) => {
        if (e.target === e.currentTarget) {
          rowsOf()[0]?.focus();
          setEntered(true);
        }
      }}
      onKeyDown={onKeyDown}
      className="xos-rlist flex flex-col overflow-hidden rounded-card border border-border-subtle"
    >
      {children}
    </div>
  );
}

type Card = ReferenceBoardProps["columns"][number]["cards"][number];

/**
 * Records grouped into columns by state. Cards move by drag or by keyboard: Space picks a card up,
 * Arrow Left and Right carry it across columns, Space drops it and Esc puts it back.
 */
export function Board({
  addLabel,
  readOnly = false,
  columns,
  onMove,
  onAdd,
  onOpen,
}: BoardProps): ReactElement {
  const t = useT();
  const dir = Direction.useDirection();
  const [cols, setCols] = useState(columns);
  const [held, setHeld] = useState<{ key: string; origin: number; at: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const cardRefs = useRef(new Map<string, HTMLElement>());

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
        setAnnouncement(`${card.title}, ${cols[colIndex]?.label ?? ""}`);
      } else {
        const from = cols[held.origin]?.state;
        const to = cols[held.at]?.state;
        if (from && to && held.origin !== held.at) onMove?.(held.key, from, to);
        setAnnouncement(`${card.title}, ${cols[held.at]?.label ?? ""}`);
        setHeld(null);
      }
    } else if (held && (e.key === forward || e.key === back)) {
      e.preventDefault();
      const to = Math.max(0, Math.min(cols.length - 1, held.at + (e.key === forward ? 1 : -1)));
      move(held.key, held.at, to);
      setHeld({ ...held, at: to });
      setAnnouncement(`${card.title}, ${cols[to]?.label ?? ""}`);
    } else if (held && e.key === "Escape") {
      e.preventDefault();
      move(held.key, held.at, held.origin);
      setAnnouncement(`${card.title}, ${cols[held.origin]?.label ?? ""}`);
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

  return (
    <div className="flex items-start gap-12 overflow-x-auto max-w-full">
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
            <h3 className="m-0 text-text-13 font-semibold">{col.label}</h3>
            <span className="text-text-secondary tabular-nums">{col.cards.length}</span>
          </header>
          {col.cards.map((card) => (
            <article
              key={card.key}
              ref={(el) => {
                if (el) cardRefs.current.set(card.key, el);
                else cardRefs.current.delete(card.key);
              }}
              role="button"
              tabIndex={0}
              aria-pressed={held?.key === card.key ? true : undefined}
              draggable={!readOnly}
              onDragStart={(e) => e.dataTransfer.setData("text/plain", `${card.key}|${ci}`)}
              onKeyDown={(e) => onCardKey(e, card, ci)}
              onDoubleClick={() => onOpen?.(card.key)}
              className={cx(
                "flex flex-col gap-8 p-12 rounded-card border border-border-subtle bg-bg-raised",
                "hover:border-border-strong aria-pressed:border-accent aria-pressed:ring-(length:--stroke-width-focus) aria-pressed:ring-accent",
                readOnly ? "cursor-pointer" : "cursor-grab",
                "forced-colors:border-[CanvasText]",
              )}
            >
              <div className="flex items-center justify-between gap-6">
                <span className="font-mono text-text-12 text-text-secondary">{card.key}</span>
                {card.owner ? <Avatar name={card.owner} /> : null}
              </div>
              <span>{card.title}</span>
              {card.meta ? (
                <span className="text-text-12 text-text-secondary">{card.meta}</span>
              ) : null}
              {card.kind || card.due ? (
                <div className="flex flex-wrap items-center gap-4">
                  {card.kind ? <RecordKindChip kind={card.kind} /> : null}
                  {card.due ? <PropertyChip icon="Calendar" value={card.due} /> : null}
                </div>
              ) : null}
            </article>
          ))}
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
      <span aria-live="assertive" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

interface FlatNode {
  node: TreeNode;
  id: string;
  depth: number;
  parent: string | null;
  hasChildren: boolean;
}

function flatten(
  nodes: TreeNode[],
  expanded: Set<string>,
  depth = 0,
  parent: string | null = null,
  prefix = "",
): FlatNode[] {
  return nodes.flatMap((node, i) => {
    const id = node.id ?? `${prefix}${i}`;
    const hasChildren = (node.children?.length ?? 0) > 0;
    const self: FlatNode = { node, id, depth, parent, hasChildren };
    return hasChildren && expanded.has(id)
      ? [self, ...flatten(node.children ?? [], expanded, depth + 1, id, `${id}.`)]
      : [self];
  });
}

function initialExpanded(nodes: TreeNode[], prefix = ""): string[] {
  return nodes.flatMap((node, i) => {
    const id = node.id ?? `${prefix}${i}`;
    const kids = node.children ?? [];
    return kids.length && node.expanded !== false ? [id, ...initialExpanded(kids, `${id}.`)] : [];
  });
}

/**
 * The scope tree. Arrow Up and Down move, Arrow Right expands or enters, Arrow Left collapses or
 * returns to the parent, Home and End jump, Enter or Space selects.
 */
export function TreeView({ label, nodes, onSelect }: TreeViewProps): ReactElement {
  const dir = Direction.useDirection();
  const [expanded, setExpanded] = useState(() => new Set(initialExpanded(nodes)));
  const visible = flatten(nodes, expanded);
  const initialSelected = visible.find((f) => f.node.selected)?.id ?? null;
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [focused, setFocused] = useState<string>(initialSelected ?? visible[0]?.id ?? "");
  const refs = useRef(new Map<string, HTMLElement>());
  const base = useId().replace(/:/g, "");

  const focus = (id: string) => {
    setFocused(id);
    refs.current.get(id)?.focus();
  };
  const toggle = (id: string, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  const select = (item: FlatNode) => {
    setSelected(item.id);
    onSelect?.(item.node);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, item: FlatNode, index: number) => {
    if (e.target !== e.currentTarget) return;
    const enter = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const leave = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const move = rovingIndex(e.key, index, visible.length, "vertical");
    if (move !== null && e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
      e.preventDefault();
      const target = visible[move];
      if (target) focus(target.id);
    } else if (e.key === enter) {
      e.preventDefault();
      if (item.hasChildren && !expanded.has(item.id)) toggle(item.id, true);
      else if (item.hasChildren) {
        const child = visible[index + 1];
        if (child) focus(child.id);
      }
    } else if (e.key === leave) {
      e.preventDefault();
      if (item.hasChildren && expanded.has(item.id)) toggle(item.id, false);
      else if (item.parent !== null) focus(item.parent);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(item);
    }
  };

  const renderLevel = (parent: string | null) =>
    visible
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.parent === parent)
      .map(({ item, index }) => {
        const open = expanded.has(item.id);
        return (
          <li
            key={item.id}
            ref={(el) => {
              if (el) refs.current.set(item.id, el);
              else refs.current.delete(item.id);
            }}
            role="treeitem"
            aria-labelledby={`${base}-${item.id}`}
            aria-level={item.depth + 1}
            aria-expanded={item.hasChildren ? open : undefined}
            aria-selected={selected === item.id}
            tabIndex={focused === item.id ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, item, index)}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocused(item.id);
            }}
            className="outline-none focus-visible:[&>div]:ring-(length:--stroke-width-focus) focus-visible:[&>div]:ring-focus-ring"
          >
            <div
              onClick={() => {
                setFocused(item.id);
                select(item);
                if (item.hasChildren) toggle(item.id, !open);
              }}
              className={cx(
                "flex items-center gap-6 h-control-md pe-8 rounded-control cursor-pointer hover:bg-bg-hover",
                selected === item.id && "bg-bg-hover",
              )}
              style={{
                paddingInlineStart: `calc(var(--space-8) + ${item.depth} * var(--space-16))`,
              }}
            >
              {item.hasChildren ? (
                <span className="text-text-tertiary">
                  <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} />
                </span>
              ) : (
                <span className="inline-block w-(--icon-size-14)" />
              )}
              {item.node.icon ? (
                <Icon name={item.node.icon} size={14} color="var(--color-text-secondary)" />
              ) : null}
              <span id={`${base}-${item.id}`}>{item.node.label}</span>
              {item.node.meta ? (
                <span className="ms-auto text-text-secondary">{item.node.meta}</span>
              ) : null}
            </div>
            {item.hasChildren && open ? (
              <ul role="group" className="m-0 p-0 list-none">
                {renderLevel(item.id)}
              </ul>
            ) : null}
          </li>
        );
      });

  return (
    <ul
      role="tree"
      aria-label={label}
      className="w-(--ui-tree) max-w-full m-0 p-0 list-none box-border"
    >
      {renderLevel(null)}
    </ul>
  );
}

/**
 * Appears with a selection: the count and at most five actions every selected item allows. A
 * toolbar: arrow keys move between actions, Esc clears the selection.
 */
export function BulkActionBar({
  count,
  actions,
  onClear,
  onMore,
}: BulkActionBarProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  return (
    <RToolbar.Root
      aria-label={t("bulk.label")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClear) {
          e.preventDefault();
          onClear();
        }
      }}
      className={cx(
        "xos-anim-fade inline-flex flex-wrap items-center gap-4 max-w-full py-4 ps-12 pe-4",
        "rounded-card bg-bg-raised shadow-menu print:hidden forced-colors:border",
      )}
    >
      <span className="tabular-nums" aria-live="polite">
        {t("bulk.selected", { n: fmt.number(count) })}
      </span>
      <RToolbar.Separator className="w-(--stroke-width-hairline) h-(--space-16) mx-4 bg-border-strong" />
      {actions.slice(0, 5).map((action) => (
        <RToolbar.Button
          key={action.label}
          className={buttonClass("ghost", "sm")}
          onClick={action.onSelect}
        >
          {action.icon ? <Icon name={action.icon} size={14} /> : null}
          {action.label}
          {action.shortcut ? (
            <span className="ms-4 inline-flex">
              <Keys keys={action.shortcut} />
            </span>
          ) : null}
        </RToolbar.Button>
      ))}
      <RToolbar.Button
        className={iconButtonClass()}
        aria-label={t("menu.more")}
        title={t("menu.more")}
        onClick={onMore}
      >
        <Icon name="Ellipsis" />
      </RToolbar.Button>
      <RToolbar.Button
        className={iconButtonClass()}
        aria-label={t("bulk.clear")}
        title={t("tooltip.withShortcut", { label: t("bulk.clear"), shortcut: t("key.esc") })}
        onClick={onClear}
      >
        <Icon name="X" />
      </RToolbar.Button>
    </RToolbar.Root>
  );
}

/** One event or comment in a feed; reactions are glyph buttons with their counts. */
export function ActivityFeedItem({
  actor,
  action,
  target,
  time,
  comment,
  reactions,
  onReact,
}: ActivityFeedItemProps): ReactElement {
  return (
    <article className="flex items-start gap-12 max-w-(--layout-peek)">
      <Avatar name={actor} />
      <div className="flex flex-1 flex-col gap-4 min-w-0">
        <p className="m-0">
          <strong className="font-semibold">{actor}</strong>{" "}
          <span className="text-text-secondary">{action}</span>{" "}
          {target ? <span className="font-mono text-text-12">{target}</span> : null}{" "}
          <time className="text-text-secondary">{time}</time>
        </p>
        {comment ? (
          <div className="px-12 py-8 rounded-card border border-border-subtle bg-bg-surface">
            {comment}
          </div>
        ) : null}
        {reactions ? (
          <div className="flex flex-wrap gap-4">
            {reactions.map((r) => (
              <button
                key={r.label}
                type="button"
                aria-label={`${r.label} ${r.count}`}
                onClick={() => onReact?.(r.label)}
                className={cx(chipClass, "xos-hit cursor-pointer hover:bg-bg-hover")}
              >
                <Icon name={r.icon} size={12} />
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * One headline number with its change and whether the change is good. Direction is an icon and a
 * signed number as well as color; a blank value reads No value, never 0.
 */
export function StatTile({
  label,
  value,
  format = "number",
  delta,
  deltaUnit,
  deltaLabel,
  goodWhen,
  caption,
  onDrill,
}: StatTileProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const direction =
    delta === undefined || delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const good =
    goodWhen !== undefined &&
    direction !== null &&
    direction !== "flat" &&
    (goodWhen === "up") === (direction === "up");
  const bad = goodWhen !== undefined && direction !== null && direction !== "flat" && !good;
  const figure =
    format === "money" ? (
      <Money amount={value} />
    ) : value === null ? (
      <span className="text-text-secondary">{t("chart.noValue")}</span>
    ) : (
      fmt.number(value)
    );
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-4 min-w-(--ui-stat-min) p-16 rounded-card border border-border-subtle bg-bg-raised"
    >
      <span className="text-text-12 font-medium text-text-secondary">{label}</span>
      <strong className="text-heading-32 font-semibold tabular-nums">
        {onDrill ? (
          <button
            type="button"
            onClick={onDrill}
            className="p-0 border-0 bg-transparent cursor-pointer text-inherit hover:underline"
          >
            {figure}
          </button>
        ) : (
          figure
        )}
      </strong>
      {direction !== null && delta !== null && delta !== undefined ? (
        <span
          className={cx(
            "flex items-center gap-4 text-text-12 text-text-secondary",
            good && "text-success-text",
            bad && "text-danger-text",
          )}
        >
          <Icon
            name={direction === "up" ? "ArrowUp" : direction === "down" ? "ArrowDown" : "Minus"}
            size={14}
          />
          <span className="tabular-nums">
            {delta > 0 ? "+" : ""}
            {fmt.number(delta)}
            {deltaUnit ?? ""}
          </span>
          {deltaLabel ? <span className="text-text-secondary">{deltaLabel}</span> : null}
        </span>
      ) : null}
      {caption ? <span className="text-text-secondary">{caption}</span> : null}
    </section>
  );
}
