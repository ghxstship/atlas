"use client";

import { Button, Checkbox, cx, Icon, iconButtonClass } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { resetSidebarAction, saveSidebarAction } from "@/lib/settings/shell-preferences-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface SidebarEditorItem {
  readonly id: string;
  readonly label: string;
  readonly hidden: boolean;
}

export interface SidebarEditorGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SidebarEditorItem[];
}

/** What is held while it moves by keyboard: a group, or an item inside a group. */
interface Held {
  readonly id: string;
  /** The group the item belongs to; null when a whole group moves. */
  readonly group: string | null;
  readonly origin: number;
}

function moveWithin<T extends { readonly id: string }>(list: readonly T[], id: string, to: number) {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0 || to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/**
 * The person's sidebar in Personal settings, Preferences (Section 4.5.2): hide items they never use and
 * put the module groups, and the items inside each group, in their own order; Reset to role default
 * brings back the starting layout. Every move works by drag and by keyboard (Section 11.7): the move
 * handle takes Space to pick up, the arrow keys to move, Space to drop and Esc to put back, and a
 * screen reader hears each step.
 */
export function SidebarEditor({
  org,
  groups: initial,
}: {
  readonly org: string;
  readonly groups: readonly SidebarEditorGroup[];
}) {
  const t = useTranslations("settings.sidebar") as unknown as Translate;
  const router = useRouter();
  const [groups, setGroups] = useState(initial);
  // After Save or Reset the server sends the layout again; take it and keep the message.
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setGroups(initial);
  }
  const [held, setHeld] = useState<Held | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef<{ readonly id: string; readonly group: string | null } | null>(null);

  const listOf = (group: string | null) =>
    group === null ? groups : (groups.find((g) => g.id === group)?.items ?? []);
  const labelOf = (id: string, group: string | null) => {
    const label = listOf(group).find((x) => x.id === id)?.label ?? id;
    return group === null ? t("group", { group: label }) : label;
  };
  const place = (id: string, group: string | null, to: number) => {
    setGroups((gs) =>
      group === null
        ? moveWithin(gs, id, to)
        : gs.map((g) => (g.id === group ? { ...g, items: moveWithin(g.items, id, to) } : g)),
    );
    requestAnimationFrame(() => handles.current.get(id)?.focus());
  };
  const say = (key: string, id: string, group: string | null, index: number) =>
    setAnnouncement(
      t(key, { item: labelOf(id, group), position: index + 1, count: listOf(group).length }),
    );

  const onHandleKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
    group: string | null,
  ) => {
    const list = listOf(group);
    const index = list.findIndex((x) => x.id === id);
    if (event.key === " ") {
      event.preventDefault();
      if (held === null) {
        setHeld({ id, group, origin: index });
        say("picked", id, group, index);
      } else {
        setHeld(null);
        say("dropped", id, group, index);
      }
    } else if (held?.id === id && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const to = Math.max(0, Math.min(list.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      place(id, group, to);
      say("moved", id, group, to);
    } else if (held?.id === id && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      place(id, group, held.origin);
      setHeld(null);
      say("returned", id, group, held.origin);
    }
  };

  const dragProps = (id: string, group: string | null, index: number) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      event.stopPropagation();
      dragged.current = { id, group };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    },
    onDragOver: (event: DragEvent<HTMLLIElement>) => {
      if (dragged.current?.group !== group) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      const from = dragged.current;
      if (from?.group !== group) return;
      event.preventDefault();
      event.stopPropagation();
      dragged.current = null;
      place(from.id, group, index);
      say("dropped", from.id, group, index);
    },
  });

  const handle = (id: string, group: string | null, label: string) => (
    <button
      type="button"
      ref={(el) => {
        if (el) handles.current.set(id, el);
        else handles.current.delete(id);
      }}
      aria-label={t("move", { item: label })}
      aria-describedby="sidebar-editor-move-help"
      aria-pressed={held?.id === id}
      onKeyDown={(event) => onHandleKey(event, id, group)}
      onBlur={() => {
        if (held?.id === id) setHeld(null);
      }}
      className={cx(
        iconButtonClass("ghost"),
        "shrink-0 cursor-grab aria-pressed:bg-bg-hover aria-pressed:text-text-primary",
      )}
    >
      <Icon name="GripVertical" size={14} />
    </button>
  );

  const save = async () => {
    setBusy(true);
    const result = await saveSidebarAction(org, [
      ...groups.map((g) => ({ nodeId: g.id, hidden: false })),
      ...groups.flatMap((g) => g.items.map((i) => ({ nodeId: i.id, hidden: i.hidden }))),
    ]);
    setBusy(false);
    setStatus(t(result.ok ? "saved" : "failed"));
    if (result.ok) router.refresh();
  };
  const reset = async () => {
    setBusy(true);
    const result = await resetSidebarAction(org);
    setBusy(false);
    setStatus(t(result.ok ? "resetDone" : "failed"));
    if (result.ok) router.refresh();
  };

  return (
    <section
      aria-labelledby="sidebar-editor-heading"
      className="flex max-w-layout-form flex-col gap-12"
    >
      <h2 id="sidebar-editor-heading" className="m-0 text-heading-16 font-semibold">
        {t("title")}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("description")}</p>
      <p id="sidebar-editor-move-help" className="m-0 text-text-12 text-text-secondary">
        {t("moveHelp")}
      </p>
      <ol className="m-0 flex list-none flex-col gap-12 p-0">
        {groups.map((group, gi) => (
          <li
            key={group.id}
            {...dragProps(group.id, null, gi)}
            className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-surface p-8"
          >
            <div className="flex items-center gap-4">
              {handle(group.id, null, t("group", { group: group.label }))}
              <h3 className="m-0 text-text-13 font-semibold">
                {t("group", { group: group.label })}
              </h3>
            </div>
            <ol className="m-0 flex list-none flex-col gap-2 p-0 ps-16">
              {group.items.map((item, ii) => (
                <li
                  key={item.id}
                  {...dragProps(item.id, group.id, ii)}
                  className="flex items-center gap-4"
                >
                  {handle(item.id, group.id, item.label)}
                  <Checkbox
                    label={t("show", { item: item.label })}
                    checked={!item.hidden}
                    onChange={(event) => {
                      const shown = event.target.checked;
                      setGroups((gs) =>
                        gs.map((g) =>
                          g.id === group.id
                            ? {
                                ...g,
                                items: g.items.map((i) =>
                                  i.id === item.id ? { ...i, hidden: !shown } : i,
                                ),
                              }
                            : g,
                        ),
                      );
                    }}
                  />
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-8">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {t("save")}
        </Button>
        <Button disabled={busy} onClick={() => void reset()}>
          {t("reset")}
        </Button>
      </div>
      <p role="status" className="m-0 text-text-13">
        {status}
      </p>
      <span aria-live="assertive" className="sr-only">
        {announcement}
      </span>
    </section>
  );
}
