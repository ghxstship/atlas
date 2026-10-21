import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Direction, Popover as RPopover } from "radix-ui";
import type { Option } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useLocale, usePreferences, useT } from "../lib/context.tsx";
import { monthCells, monthTitle, parseIso, toIso, weekStart, weekdayNames } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { iconButtonClass } from "../Button/Button.tsx";
import { controlClass } from "../Field/Field.tsx";
import { popoverPanelClass } from "../Overlays/Overlays.tsx";
import { type GridProps, type ListState } from "./Pickers.types.ts";
import { rankOptions } from "./rankOptions.tsx";

export const listboxClass = cx(
  popoverPanelClass,
  "z-dropdown p-4 max-h-(--ui-listbox-max) overflow-y-auto w-(--radix-popover-trigger-width)",
);

export const optionClass = cx(
  "flex items-center gap-8 min-h-control-lg px-8 py-4 rounded-control cursor-pointer",
  "aria-selected:font-medium data-[active=true]:bg-bg-hover hover:bg-bg-hover pointer-coarse:min-h-target-coarse",
);

export function OptionBody({ option, selected }: { option: Option; selected: boolean }) {
  return (
    <>
      {option.icon ? <Icon name={option.icon} size={14} /> : null}
      <span className="flex-1 min-w-0">{option.label}</span>
      {option.code ? (
        <span className="flex-none font-mono text-text-12 text-text-secondary">{option.code}</span>
      ) : null}
      {selected ? (
        <span className="text-accent">
          <Icon name="Check" size={14} />
        </span>
      ) : null}
    </>
  );
}

export function useList(options: Option[], defaultOpen: boolean | undefined): ListState {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [active, setActive] = useState(0);
  const list = useMemo(() => rankOptions(options, query), [options, query]);
  return {
    query,
    setQuery,
    open,
    setOpen,
    active: Math.min(active, Math.max(0, list.length - 1)),
    setActive,
    list,
  };
}

export function listKeys(
  e: KeyboardEvent<HTMLInputElement>,
  s: ListState,
  pick: (o: Option) => void,
): boolean {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!s.open) s.setOpen(true);
    else s.setActive(Math.min(s.active + 1, s.list.length - 1));
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    s.setActive(Math.max(s.active - 1, 0));
    return true;
  }
  if (e.key === "Home" && s.open) {
    e.preventDefault();
    s.setActive(0);
    return true;
  }
  if (e.key === "End" && s.open) {
    e.preventDefault();
    s.setActive(s.list.length - 1);
    return true;
  }
  if (e.key === "Enter" && s.open) {
    const option = s.list[s.active];
    if (option) {
      e.preventDefault();
      pick(option);
    }
    return true;
  }
  if (e.key === "Escape" && s.open) {
    e.preventDefault();
    s.setOpen(false);
    return true;
  }
  return false;
}

export function Listbox({
  id,
  state,
  isSelected,
  pick,
  multiselectable = false,
  noMatch,
}: {
  id: string;
  state: ListState;
  isSelected: (o: Option) => boolean;
  pick: (o: Option) => void;
  multiselectable?: boolean;
  noMatch: string;
}) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        sideOffset={4}
        align="start"
        collisionPadding={16}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.(`[data-combobox="${id}"]`))
            e.preventDefault();
        }}
        role="presentation"
        className={listboxClass}
      >
        <div role="listbox" id={`${id}-list`} aria-multiselectable={multiselectable || undefined}>
          {state.list.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={isSelected(o)}
              data-active={i === state.active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => state.setActive(i)}
              className={optionClass}
            >
              <OptionBody option={o} selected={isSelected(o)} />
            </div>
          ))}
        </div>
        {state.list.length === 0 ? (
          <p className="m-0 px-8 py-8 text-text-secondary">{noMatch}</p>
        ) : null}
      </RPopover.Content>
    </RPopover.Portal>
  );
}

export function shiftIso(iso: string, days: number): string {
  const { y, m, d } = parseIso(iso);
  const date = new Date(y, m, d + days);
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

export function shiftMonth(iso: string, months: number): string {
  const { y, m, d } = parseIso(iso);
  const last = new Date(y, m + months + 1, 0).getDate();
  const date = new Date(y, m + months, Math.min(d, last));
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * The date grid of the APG date picker dialog: arrows move a day or a week, Page Up and Page Down a
 * month, Home and End the week, Enter or Space picks.
 */
export function MonthGrid({ year, month, focused, onFocusDate, onPick, mark }: GridProps) {
  const locale = useLocale();
  const { weekStart: firstDay } = usePreferences();
  const dir = Direction.useDirection();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const title = monthTitle(locale, year, month);
  useEffect(() => {
    refs.current.get(focused)?.focus();
  }, [focused]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, iso: string) => {
    const ahead = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const behind = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const { y, m, d } = parseIso(iso);
    const dow = (new Date(y, m, d).getDay() - weekStart(locale, firstDay) + 7) % 7;
    const next =
      e.key === ahead
        ? shiftIso(iso, 1)
        : e.key === behind
          ? shiftIso(iso, -1)
          : e.key === "ArrowDown"
            ? shiftIso(iso, 7)
            : e.key === "ArrowUp"
              ? shiftIso(iso, -7)
              : e.key === "PageDown"
                ? shiftMonth(iso, e.shiftKey ? 12 : 1)
                : e.key === "PageUp"
                  ? shiftMonth(iso, e.shiftKey ? -12 : -1)
                  : e.key === "Home"
                    ? shiftIso(iso, -dow)
                    : e.key === "End"
                      ? shiftIso(iso, 6 - dow)
                      : null;
    if (next) {
      e.preventDefault();
      onFocusDate(next);
    }
  };
  return (
    <table role="grid" aria-label={title} className="border-collapse">
      <thead>
        <tr>
          {weekdayNames(locale, firstDay).map((d) => (
            <th
              key={d}
              scope="col"
              className="h-control-sm text-text-11 font-medium text-text-tertiary"
            >
              {d}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {monthCells(locale, year, month, firstDay).map((week, wi) => (
          <tr key={wi}>
            {week.map((d, di) => {
              if (d === null) return <td key={di} />;
              const iso = toIso(year, month, d);
              const state = mark(iso);
              return (
                <td key={di} className="p-0 text-center">
                  <button
                    ref={(el) => {
                      if (el) refs.current.set(iso, el);
                      else refs.current.delete(iso);
                    }}
                    type="button"
                    tabIndex={iso === focused ? 0 : -1}
                    aria-pressed={state === "selected" || state === "edge"}
                    aria-current={state === "today" ? "date" : undefined}
                    onClick={() => onPick(iso)}
                    onKeyDown={(e) => onKeyDown(e, iso)}
                    className={cx(
                      "w-(--ui-day-inline) h-(--ui-day-block) rounded-control border-0 bg-transparent cursor-pointer tabular-nums text-text-13",
                      "hover:bg-bg-hover pointer-coarse:min-h-target-coarse",
                      state === "today" &&
                        "ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                      (state === "selected" || state === "edge") &&
                        "bg-accent text-accent-text-on font-semibold hover:bg-accent",
                      state === "range" && "bg-bg-hover rounded-none",
                    )}
                  >
                    {d}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CalendarPanel({
  label,
  initial,
  mark,
  onPick,
}: {
  label: string;
  initial: string;
  mark: GridProps["mark"];
  onPick: (iso: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [focused, setFocused] = useState(initial);
  const { y, m } = parseIso(focused);
  return (
    <RPopover.Portal>
      <RPopover.Content
        role="dialog"
        aria-label={label}
        sideOffset={4}
        align="start"
        collisionPadding={16}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cx(popoverPanelClass, "z-popover p-8")}
      >
        <div className="flex items-center justify-between gap-8 pb-8">
          <button
            type="button"
            className={iconButtonClass()}
            aria-label={t("date.prevMonth")}
            onClick={() => setFocused(shiftMonth(focused, -1))}
          >
            <Icon name="ChevronLeft" />
          </button>
          <strong className="font-semibold" aria-live="polite">
            {monthTitle(locale, y, m)}
          </strong>
          <button
            type="button"
            className={iconButtonClass()}
            aria-label={t("date.nextMonth")}
            onClick={() => setFocused(shiftMonth(focused, 1))}
          >
            <Icon name="ChevronRight" />
          </button>
        </div>
        <MonthGrid
          year={y}
          month={m}
          focused={focused}
          onFocusDate={setFocused}
          onPick={onPick}
          mark={mark}
        />
      </RPopover.Content>
    </RPopover.Portal>
  );
}

export const triggerClass = cx(
  controlClass,
  "flex items-center gap-8 w-full text-start cursor-pointer [&_svg]:text-text-secondary",
);

export function todayIso(): string {
  const now = new Date();
  return toIso(now.getFullYear(), now.getMonth(), now.getDate());
}
