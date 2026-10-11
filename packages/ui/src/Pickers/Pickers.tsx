import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { defaultFilter } from "cmdk";
import { Direction, Popover as RPopover, Slider as RSlider } from "radix-ui";
import type {
  ComboboxProps as ReferenceComboboxProps,
  DatePickerProps as ReferenceDatePickerProps,
  DateRangePickerProps as ReferenceDateRangePickerProps,
  FileDropProps as ReferenceFileDropProps,
  MultiSelectProps as ReferenceMultiSelectProps,
  Option,
  SliderProps as ReferenceSliderProps,
  TimePickerProps as ReferenceTimePickerProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useLocale, useT } from "../lib/context.tsx";
import {
  formatDate,
  formatTimeOfDay,
  monthCells,
  monthTitle,
  parseIso,
  toIso,
  weekStart,
  weekdayNames,
} from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { iconButtonClass } from "../Button/Button.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import {
  Field,
  controlClass,
  describedBy,
  fieldClass,
  helpClass,
  labelClass,
  useFieldId,
} from "../Field/Field.tsx";
import { popoverPanelClass } from "../Overlays/Overlays.tsx";

export type ComboboxProps = ReferenceComboboxProps & { id?: string };
export type MultiSelectProps = ReferenceMultiSelectProps & { id?: string };
export type SliderProps = ReferenceSliderProps & { id?: string };
export type DatePickerProps = ReferenceDatePickerProps & { id?: string };
export type DateRangePickerProps = ReferenceDateRangePickerProps & { id?: string };
export type TimePickerProps = ReferenceTimePickerProps & { id?: string; name?: string };
export type FileDropProps = ReferenceFileDropProps & { id?: string };

/** Ranks options against a query with cmdk's fuzzy score; an empty query keeps the given order. */
export function rankOptions(options: Option[], query: string): Option[] {
  if (!query.trim()) return options;
  return options
    .map((o) => ({ o, score: defaultFilter(`${o.label} ${o.code ?? ""}`, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.o);
}

const listboxClass = cx(
  popoverPanelClass,
  "z-dropdown p-4 max-h-(--ui-listbox-max) overflow-y-auto w-(--radix-popover-trigger-width)",
);
const optionClass = cx(
  "flex items-center gap-8 min-h-control-lg px-8 py-4 rounded-control cursor-pointer",
  "aria-selected:font-medium data-[active=true]:bg-bg-hover hover:bg-bg-hover pointer-coarse:min-h-target-coarse",
);

function OptionBody({ option, selected }: { option: Option; selected: boolean }) {
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

interface ListState {
  query: string;
  setQuery: (q: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  active: number;
  setActive: (n: number) => void;
  list: Option[];
}

function useList(options: Option[], defaultOpen: boolean | undefined): ListState {
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

function listKeys(
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

function Listbox({
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

/**
 * Searches a long list as the person types (fuzzy ranking from cmdk, positioned on Radix Popover).
 * Arrow keys move, Enter picks, Escape closes.
 */
export function Combobox({
  label,
  help,
  value,
  placeholder: hint,
  noMatch,
  options,
  defaultOpen,
  onChange,
  id,
}: ComboboxProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const s = useList(options, defaultOpen);
  const [current, setCurrent] = useState(value);
  const chosen = options.find((o) => o.value === current);
  const pick = (o: Option) => {
    setCurrent(o.value);
    s.setQuery("");
    s.setOpen(false);
    onChange?.(o.value);
  };
  return (
    <Field id={fieldId} label={label} help={help}>
      <RPopover.Root
        open={s.open && (s.list.length > 0 || s.query !== "")}
        onOpenChange={s.setOpen}
      >
        <RPopover.Anchor asChild>
          <div className="relative" data-combobox={fieldId}>
            <input
              id={fieldId}
              role="combobox"
              aria-expanded={s.open}
              aria-controls={s.open ? `${fieldId}-list` : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                s.open && s.list.length ? `${fieldId}-opt-${s.active}` : undefined
              }
              aria-describedby={describedBy(fieldId, help, undefined)}
              autoComplete="off"
              value={s.query}
              placeholder={chosen?.label ?? hint}
              onFocus={() => s.setOpen(true)}
              onBlur={() => {
                if (!defaultOpen) s.setOpen(false);
              }}
              onChange={(e) => {
                s.setQuery(e.target.value);
                s.setOpen(true);
                s.setActive(0);
              }}
              onKeyDown={(e) => listKeys(e, s, pick)}
              className={cx(
                controlClass,
                "w-full pe-24",
                chosen && "placeholder:text-text-primary",
              )}
            />
            <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
              <Icon name="ChevronsUpDown" size={14} />
            </span>
          </div>
        </RPopover.Anchor>
        <Listbox
          id={fieldId}
          state={s}
          isSelected={(o) => o.value === current}
          pick={pick}
          noMatch={noMatch ?? t("list.noMatch")}
        />
      </RPopover.Root>
    </Field>
  );
}

/** Picks several values; picks show as removable chips and Backspace removes the last. */
export function MultiSelect({
  label,
  help,
  value,
  placeholder: hint,
  options,
  defaultOpen,
  onChange,
  id,
}: MultiSelectProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const s = useList(options, defaultOpen);
  const [picked, setPicked] = useState(value ?? []);
  const set = (next: string[]) => {
    setPicked(next);
    onChange?.(next);
  };
  const toggle = (o: Option) =>
    set(picked.includes(o.value) ? picked.filter((v) => v !== o.value) : [...picked, o.value]);
  const chosen = options.filter((o) => picked.includes(o.value));
  return (
    <div className={fieldClass}>
      {label ? (
        <label className={labelClass} htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <RPopover.Root open={s.open} onOpenChange={s.setOpen}>
        <RPopover.Anchor asChild>
          <div
            data-combobox={fieldId}
            className={cx(
              controlClass,
              "relative flex flex-wrap items-center gap-4 h-auto min-h-control-md py-2 ps-4 pe-24",
            )}
          >
            {chosen.map((o) => (
              <span key={o.value} className={cx(chipClass, "h-(--ui-tag)")}>
                {o.label}
                <button
                  type="button"
                  aria-label={t("chip.remove", { label: o.label })}
                  onClick={() => toggle(o)}
                  className="xos-hit inline-grid place-items-center ms-2 p-0 border-0 bg-transparent text-text-tertiary hover:text-text-primary rounded-mark cursor-pointer"
                >
                  <Icon name="X" size={12} />
                </button>
              </span>
            ))}
            <input
              id={fieldId}
              role="combobox"
              aria-expanded={s.open}
              aria-controls={s.open ? `${fieldId}-list` : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                s.open && s.list.length ? `${fieldId}-opt-${s.active}` : undefined
              }
              aria-describedby={help ? `${fieldId}-help` : undefined}
              autoComplete="off"
              value={s.query}
              placeholder={chosen.length ? "" : hint}
              onFocus={() => s.setOpen(true)}
              onBlur={() => {
                if (!defaultOpen) s.setOpen(false);
              }}
              onChange={(e) => {
                s.setQuery(e.target.value);
                s.setOpen(true);
                s.setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !s.query && chosen.length) {
                  const last = chosen[chosen.length - 1];
                  if (last) toggle(last);
                  return;
                }
                listKeys(e, s, toggle);
              }}
              className="flex-1 min-w-(--space-64) border-0 bg-transparent outline-none text-text-primary text-text-13 placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
            />
            <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
              <Icon name="ChevronsUpDown" size={14} />
            </span>
          </div>
        </RPopover.Anchor>
        <Listbox
          id={fieldId}
          state={s}
          isSelected={(o) => picked.includes(o.value)}
          pick={toggle}
          multiselectable
          noMatch={t("list.noMatch")}
        />
      </RPopover.Root>
      {help ? (
        <div className={helpClass} id={`${fieldId}-help`}>
          {help}
        </div>
      ) : null}
    </div>
  );
}

/** A value in a bounded range on Radix Slider, always showing the current value beside its label. */
export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  unit,
  onChange,
  id,
}: SliderProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const fmt = useFormat();
  const [current, setCurrent] = useState(value);
  const shown = unit
    ? t("slider.value", { value: fmt.number(current), unit })
    : fmt.number(current);
  return (
    <div className={fieldClass}>
      <div className="flex justify-between text-text-12">
        <span id={`${fieldId}-label`} className={labelClass}>
          {label}
        </span>
        <output htmlFor={fieldId} className="tabular-nums text-text-secondary">
          {shown}
        </output>
      </div>
      <RSlider.Root
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([v]) => {
          if (v === undefined) return;
          setCurrent(v);
          onChange?.(v);
        }}
        className="relative flex items-center h-control-md touch-none select-none pointer-coarse:min-h-target-coarse"
      >
        <RSlider.Track className="relative grow h-(--space-4) rounded-pill bg-bg-hover overflow-hidden">
          <RSlider.Range className="absolute h-full bg-accent" />
        </RSlider.Track>
        <RSlider.Thumb
          id={fieldId}
          aria-labelledby={`${fieldId}-label`}
          aria-valuetext={shown}
          className="block size-(--space-16) rounded-full bg-text-primary ring-(length:--stroke-width-focus) ring-bg-canvas cursor-grab"
        />
      </RSlider.Root>
    </div>
  );
}

interface GridProps {
  year: number;
  month: number;
  focused: string;
  onFocusDate: (iso: string) => void;
  onPick: (iso: string) => void;
  mark: (iso: string) => "selected" | "edge" | "range" | "today" | null;
}

function shiftIso(iso: string, days: number): string {
  const { y, m, d } = parseIso(iso);
  const date = new Date(y, m, d + days);
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

function shiftMonth(iso: string, months: number): string {
  const { y, m, d } = parseIso(iso);
  const last = new Date(y, m + months + 1, 0).getDate();
  const date = new Date(y, m + months, Math.min(d, last));
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * The date grid of the APG date picker dialog: arrows move a day or a week, Page Up and Page Down a
 * month, Home and End the week, Enter or Space picks.
 */
function MonthGrid({ year, month, focused, onFocusDate, onPick, mark }: GridProps) {
  const locale = useLocale();
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
    const dow = (new Date(y, m, d).getDay() - weekStart(locale) + 7) % 7;
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
          {weekdayNames(locale).map((d) => (
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
        {monthCells(locale, year, month).map((week, wi) => (
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

function CalendarPanel({
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

const triggerClass = cx(
  controlClass,
  "flex items-center gap-8 w-full text-start cursor-pointer [&_svg]:text-text-secondary",
);

function todayIso(): string {
  const now = new Date();
  return toIso(now.getFullYear(), now.getMonth(), now.getDate());
}

/** One date from a month grid in a popover dialog; dates display as Oct 30, 2026. */
export function DatePicker({
  label,
  help,
  value,
  month,
  today,
  placeholder: hint,
  defaultOpen,
  onChange,
  id,
}: DatePickerProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const fieldId = useFieldId(id);
  const [current, setCurrent] = useState(value);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const initial = current ?? month ?? today ?? todayIso();
  return (
    <Field id={fieldId} label={label} help={help}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild>
          <button
            id={fieldId}
            type="button"
            aria-haspopup="dialog"
            aria-labelledby={label ? `${fieldId}-label ${fieldId}` : undefined}
            className={triggerClass}
            aria-describedby={describedBy(fieldId, help, undefined)}
          >
            <Icon name="Calendar" size={14} />
            <span className={current ? undefined : "text-text-tertiary"}>
              {current ? formatDate(locale, current) : (hint ?? t("date.pick"))}
            </span>
          </button>
        </RPopover.Trigger>
        <CalendarPanel
          label={t("date.choose")}
          initial={initial}
          mark={(iso) => (iso === current ? "selected" : iso === today ? "today" : null)}
          onPick={(iso) => {
            setCurrent(iso);
            onChange?.(iso);
            setOpen(false);
          }}
        />
      </RPopover.Root>
    </Field>
  );
}

/** A start and end date with the length in days; the first pick starts a range, the second ends it. */
export function DateRangePicker({
  label,
  help,
  start,
  end,
  defaultOpen,
  onChange,
  id,
}: DateRangePickerProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const fieldId = useFieldId(id);
  const [range, setRange] = useState<[string | undefined, string | undefined]>([start, end]);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [a, b] = range;
  const days = a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1 : null;
  const pick = (iso: string) => {
    const next: [string, string | undefined] =
      !a || b ? [iso, undefined] : iso < a ? [iso, a] : [a, iso];
    setRange(next);
    if (next[1]) {
      onChange?.([next[0], next[1]]);
      setOpen(false);
    }
  };
  return (
    <Field id={fieldId} label={label} help={help}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild>
          <button
            id={fieldId}
            type="button"
            aria-haspopup="dialog"
            aria-labelledby={label ? `${fieldId}-label ${fieldId}` : undefined}
            className={triggerClass}
            aria-describedby={describedBy(fieldId, help, undefined)}
          >
            <Icon name="CalendarRange" size={14} />
            <span className={a ? undefined : "text-text-tertiary"}>
              {a
                ? b
                  ? t("date.rangeValue", {
                      start: formatDate(locale, a),
                      end: formatDate(locale, b),
                    })
                  : formatDate(locale, a)
                : t("date.chooseRange")}
            </span>
            {days !== null ? (
              <span className="ms-auto text-text-secondary tabular-nums">
                {t("date.days", { n: days })}
              </span>
            ) : null}
          </button>
        </RPopover.Trigger>
        <CalendarPanel
          label={t("date.chooseRange")}
          initial={a ?? todayIso()}
          mark={(iso) =>
            iso === a || iso === b ? "edge" : a && b && iso > a && iso < b ? "range" : null
          }
          onPick={pick}
        />
      </RPopover.Root>
    </Field>
  );
}

/**
 * A time of day with the venue time zone always beside it. The contract keeps a native select change
 * event; times read in the locale's format (12-hour with AM and PM in en-US).
 */
export function TimePicker({
  label,
  help,
  value,
  step = 15,
  timeZone,
  zoneLabel,
  onChange,
  id,
  name,
}: TimePickerProps): ReactElement {
  const locale = useLocale();
  const fieldId = useFieldId(id);
  const options = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (let mins = 0; mins < 1440; mins += step) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      out.push({
        value: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        label: formatTimeOfDay(locale, h, m),
      });
    }
    return out;
  }, [locale, step]);
  return (
    <Field id={fieldId} label={label} help={help}>
      <div className="flex items-center gap-6">
        <div className="relative flex-1">
          <select
            id={fieldId}
            name={name}
            defaultValue={value}
            onChange={onChange}
            aria-describedby={`${fieldId}-zone${help ? ` ${fieldId}-help` : ""}`}
            className={cx(controlClass, "appearance-none w-full pe-24")}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
            <Icon name="Clock" size={14} />
          </span>
        </div>
        <span id={`${fieldId}-zone`} title={timeZone} className={chipClass}>
          <Icon name="Globe" size={12} />
          {zoneLabel}
        </span>
      </div>
    </Field>
  );
}

/** Files by drag or browse, with a keyboard-reachable input and a list of what was added. */
export function FileDrop({
  label,
  hint,
  accept,
  width,
  files: initial,
  onFiles,
  id,
}: FileDropProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const inputId = useFieldId(id);
  const [over, setOver] = useState(false);
  const [files, setFiles] = useState(initial ?? []);
  const add = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFiles((current) => [
      ...current,
      ...Array.from(list, (f) => ({ name: f.name, size: f.size })),
    ]);
    onFiles?.(list);
  };
  return (
    <div
      className={fieldClass}
      style={width === undefined ? { inlineSize: "var(--ui-popover)" } : { inlineSize: width }}
    >
      {label ? <span className={labelClass}>{label}</span> : null}
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
        className={cx(
          "flex flex-col items-center gap-4 p-24 text-center rounded-card border border-dashed border-border-strong bg-bg-surface text-text-secondary cursor-pointer",
          "transition-colors duration-fast ease-standard focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring",
          over && "border-accent bg-bg-hover",
        )}
      >
        <Icon name="Upload" size={20} />
        <span>
          <strong className="text-text-primary">{t("file.drop")}</strong> {t("file.orBrowse")}
        </span>
        {hint ? <span className={helpClass}>{hint}</span> : null}
        <input
          id={inputId}
          type="file"
          multiple
          accept={accept}
          onChange={(e) => add(e.target.files)}
          className="sr-only"
        />
      </label>
      {files.length ? (
        <ul className="flex flex-col gap-4 m-0 p-0 list-none" aria-live="polite">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-8">
              <Icon name="File" size={14} />
              <span>{f.name}</span>
              <span className="ms-auto text-text-secondary tabular-nums">
                {t("file.kb", { n: fmt.number(Math.max(1, Math.round(f.size / 1024))) })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
