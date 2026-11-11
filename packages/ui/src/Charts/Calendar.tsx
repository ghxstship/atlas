import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useFormat, useLocale, usePreferences, useT } from "../lib/context.tsx";
import { isMenuKey, useItemSelection } from "../lib/selection.ts";
import {
  formatDate,
  monthCells,
  monthTitle,
  parseIso,
  toIso,
  weekdayNames,
} from "../lib/format.ts";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type CalendarProps, type TimelineCategory } from "./Charts.types.ts";
import { TL_CATEGORY } from "./categories.ts";

/**
 * Dated records by month or agenda with state icons. With `selection`, events that have an `id`
 * select as rows of a list do (X and Shift+X, Cmd or Ctrl+click, Shift+click, Cmd or Ctrl+A, Esc),
 * in date order. Right-click, Shift+F10 or the Context Menu key on such an event calls
 * `onItemContextMenu`. An event carries its `data-item` id and `data-column="title"`, so a page can
 * preview it (hover cards). `days` gives dates their day-type tags (B4), each drawn as text with an icon and a
 * categorical swatch, so a type never reads by colour alone.
 */
export function Calendar({
  month,
  today,
  events,
  days = [],
  onEventSelect,
  selection,
  onItemContextMenu,
}: CalendarProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const locale = useLocale();
  const { weekStart: firstDay, dateFormat } = usePreferences();
  const [view, setView] = useState("month");
  const { y, m } = parseIso(month);
  const title = monthTitle(locale, y, m);
  const byDate = new Map<string, CalendarProps["events"]>();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const tagsByDate = new Map(days.map((d) => [d.date, d.tags]));
  const tagList = (tags: readonly TimelineCategory[] | undefined) =>
    tags && tags.length > 0 ? (
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("calendar.dayTypes")}>
        {tags.map((tag) => (
          <li
            key={tag.label}
            className="inline-flex max-w-full items-center gap-2 rounded-chip bg-bg-surface px-2 text-text-11 text-text-secondary"
          >
            <span
              aria-hidden="true"
              className={cx(
                "inline-block size-(--space-6) flex-none rounded-mark",
                TL_CATEGORY[tag.category],
              )}
            />
            {tag.icon ? <Icon name={tag.icon} size={12} /> : null}
            <span className="truncate">{tag.label}</span>
          </li>
        ))}
      </ul>
    ) : null;
  const ids = () => sorted.flatMap((e) => (e.id === undefined ? [] : [e.id]));
  const select = useItemSelection(selection, ids);
  const selectedCount = selection ? ids().filter(select.isSelected).length : 0;
  const eventButton = (e: CalendarProps["events"][number], i: number) => {
    const id = e.id;
    const selected = id !== undefined && select.isSelected(id);
    return (
      <button
        key={`${e.label}-${i}`}
        type="button"
        data-item={id}
        data-column="title"
        data-selected={selected ? "" : undefined}
        onClick={(event) => {
          if (id === undefined || !select.onClick(event, id)) onEventSelect?.(e);
        }}
        {...(id === undefined
          ? {}
          : {
              onKeyDown: (event) => {
                if (onItemContextMenu && isMenuKey(event)) {
                  event.preventDefault();
                  onItemContextMenu(id, null, event.currentTarget);
                  return;
                }
                select.onKey(event, id);
              },
              ...(selection
                ? {
                    onMouseDown: (event) => {
                      // Shift+click selects a range, not the text between.
                      if (event.shiftKey) event.preventDefault();
                    },
                  }
                : {}),
              ...(onItemContextMenu
                ? {
                    onContextMenu: (event) => {
                      event.preventDefault();
                      onItemContextMenu(
                        id,
                        { x: event.clientX, y: event.clientY },
                        event.currentTarget,
                      );
                    },
                  }
                : {}),
            })}
        className={cx(
          "flex items-center gap-4 w-full min-h-(--space-24) px-4 py-2 rounded-chip border-0 bg-bg-hover text-start text-text-12 truncate cursor-pointer",
          "data-selected:ring-(length:--stroke-width-focus) data-selected:ring-inset data-selected:ring-accent",
        )}
      >
        <StateIcon state={e.state} size={12} />
        <span className="truncate">{e.label}</span>
        {selected ? <span className="sr-only">{t("bulk.itemSelected")}</span> : null}
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-8">
      {selection ? (
        <span role="status" className="sr-only">
          {selectedCount > 0 ? t("bulk.selected", { n: fmt.number(selectedCount) }) : ""}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 className="m-0 text-heading-16 font-semibold">{title}</h2>
        <SegmentedControl
          label={t("calendar.range")}
          value={view}
          onChange={setView}
          options={[
            { value: "month", label: t("calendar.month") },
            { value: "agenda", label: t("calendar.agenda") },
          ]}
        />
      </div>
      {view === "agenda" ? (
        <ol className="flex flex-col m-0 p-0 list-none">
          {sorted.map((e, i) => (
            <li
              key={`${e.date}-${i}`}
              className="grid grid-cols-[var(--ui-props-label)_minmax(0,1fr)] items-center gap-8 min-h-row-default border-b border-border-subtle"
            >
              <time dateTime={e.date} className="text-text-secondary tabular-nums">
                {formatDate(locale, e.date, dateFormat)}
              </time>
              <div className="flex min-w-0 flex-col gap-2">
                {i === sorted.findIndex((x) => x.date === e.date)
                  ? tagList(tagsByDate.get(e.date))
                  : null}
                {eventButton(e, i)}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <table
          aria-label={title}
          className="w-full table-fixed border-collapse border-s border-t border-border-subtle"
        >
          <thead>
            <tr>
              {weekdayNames(locale, firstDay).map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="p-6 max-sm:px-2 text-center text-text-11 font-medium text-text-secondary bg-bg-surface border-e border-b border-border-subtle"
                >
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthCells(locale, y, m, firstDay).map((week, wi) => (
              <tr key={wi}>
                {week.map((d, di) => {
                  const iso = d === null ? null : toIso(y, m, d);
                  const dayEvents = iso ? (byDate.get(iso) ?? []) : [];
                  return (
                    <td
                      key={di}
                      className={cx(
                        "min-h-(--space-64) p-4 align-top border-e border-b border-border-subtle text-text-12",
                        d === null && "bg-bg-surface",
                      )}
                    >
                      {d !== null ? (
                        <div className="flex flex-col gap-2">
                          <span
                            aria-current={iso === today ? "date" : undefined}
                            className={cx(
                              "self-start px-4 py-2 rounded-chip text-text-11 text-text-secondary tabular-nums",
                              iso === today &&
                                "text-text-primary font-semibold ring-(length:--stroke-width-focus) ring-inset ring-accent",
                            )}
                          >
                            {d}
                          </span>
                          {tagList(iso ? tagsByDate.get(iso) : undefined)}
                          {dayEvents.slice(0, 3).map(eventButton)}
                          {dayEvents.length > 3 ? (
                            <span className="text-text-secondary">
                              {t("calendar.more", { n: dayEvents.length - 3 })}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
