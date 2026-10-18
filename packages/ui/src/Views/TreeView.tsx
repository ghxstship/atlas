import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Direction } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { rovingIndex } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type FlatNode, type TreeNode, type TreeViewProps } from "./Views.types.ts";

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
