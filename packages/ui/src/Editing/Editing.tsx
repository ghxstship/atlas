import { useState, type ReactElement } from "react";
import * as chrono from "chrono-node";
import type {
  ColorPickerProps as ReferenceColorPickerProps,
  DiffViewerProps as ReferenceDiffViewerProps,
  FilterBuilderProps as ReferenceFilterBuilderProps,
  QuickAddProps as ReferenceQuickAddProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { toIso } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Kbd } from "../Kbd/Kbd.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import {
  controlClass,
  errorClass,
  fieldClass,
  helpClass,
  labelClass,
  useFieldId,
} from "../Field/Field.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { isRecordKind } from "@xos/icons";

type Filter = ReferenceFilterBuilderProps["filters"][number];

export type FilterBuilderProps = ReferenceFilterBuilderProps & {
  onChange?: (filters: Filter[]) => void;
  onAdd?: () => void;
  onSave?: (filters: Filter[]) => void;
  /** Opens the editor for one filter chip. */
  onEdit?: (filter: Filter, index: number) => void;
};
export type QuickAddProps = ReferenceQuickAddProps & {
  onSubmit?: (parsed: QuickAddResult) => void;
  /** Reference date for relative phrases such as tomorrow; now by default. */
  referenceDate?: Date;
};
export type ColorPickerProps = ReferenceColorPickerProps & {
  /** Called with the value and whether it is a valid hex that passes every check. */
  onChange?: (value: string, savable: boolean) => void;
};
export type DiffViewerProps = ReferenceDiffViewerProps;

export interface QuickAddToken {
  type: "person" | "tag" | "kind" | "scope" | "date";
  value: string;
  icon: string;
  /** For dates: the parsed day as an ISO date. */
  iso?: string;
}

export interface QuickAddResult {
  title: string;
  tokens: QuickAddToken[];
}

const RULES: [RegExp, QuickAddToken["type"], string][] = [
  [/@([A-Za-z][\w.-]*)/g, "person", "User"],
  [/#([\w-]+)/g, "tag", "Hash"],
  [/\/([A-Za-z]+)/g, "kind", "Shapes"],
  [/~([\w-]+)/g, "scope", "MapPin"],
];

/**
 * Parses @person, #tag, /kind and ~scope tokens, then date phrases with chrono-node ("tomorrow",
 * "next Friday at 3pm"). What remains is the title.
 */
export function parseQuickAdd(text: string, referenceDate: Date = new Date()): QuickAddResult {
  const tokens: QuickAddToken[] = [];
  let title = text;
  for (const [pattern, type, icon] of RULES) {
    title = title.replace(pattern, (_match, value: string) => {
      tokens.push({ type, value, icon });
      return " ";
    });
  }
  const dates = chrono.parse(title, referenceDate, { forwardDate: true });
  for (const d of [...dates].reverse()) {
    const day = d.start.date();
    tokens.push({
      type: "date",
      value: d.text,
      icon: "Calendar",
      iso: toIso(day.getFullYear(), day.getMonth(), day.getDate()),
    });
    title = title.slice(0, d.index) + " " + title.slice(d.index + d.text.length);
  }
  return { title: title.replace(/\s+/g, " ").trim(), tokens };
}

/** WCAG 2.2 contrast ratio between two hex colors, the same arithmetic as the @xos/tokens contrast gate. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * lin(parseInt(h.substring(0, 2), 16)) +
      0.7152 * lin(parseInt(h.substring(2, 4), 16)) +
      0.0722 * lin(parseInt(h.substring(4, 6), 16))
    );
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Filters as chips: each opens its editor, removes with its button, and the set saves as a view. */
export function FilterBuilder({
  filters,
  addLabel,
  saveLabel,
  onChange,
  onAdd,
  onSave,
  onEdit,
}: FilterBuilderProps): ReactElement {
  const t = useT();
  const [current, setCurrent] = useState(filters);
  const set = (next: Filter[]) => {
    setCurrent(next);
    onChange?.(next);
  };
  return (
    <div role="group" aria-label={t("filter.label")} className="flex flex-wrap items-center gap-6">
      {current.map((f, i) => (
        <span key={`${f.field}-${i}`} className={chipClass}>
          <button
            type="button"
            onClick={() => onEdit?.(f, i)}
            className="xos-hit inline-flex items-center gap-4 p-0 border-0 bg-transparent cursor-pointer text-inherit"
          >
            <span className="text-text-secondary">{f.field}</span>{" "}
            <span className="text-text-secondary">{f.op}</span>{" "}
            <strong className="font-medium">{f.value}</strong>
          </button>
          <button
            type="button"
            aria-label={t("filter.remove", { field: f.field })}
            onClick={() => set(current.filter((_, j) => j !== i))}
            className="xos-hit inline-grid place-items-center ms-2 p-0 border-0 bg-transparent text-text-tertiary hover:text-text-primary rounded-mark cursor-pointer"
          >
            <Icon name="X" size={12} />
          </button>
        </span>
      ))}
      <Button size="sm" variant="ghost" icon="ListFilter" onClick={onAdd}>
        {addLabel ?? t("filter.add")}
      </Button>
      {current.length ? (
        <Button size="sm" variant="ghost" onClick={() => set([])}>
          {t("action.clear")}
        </Button>
      ) : null}
      {saveLabel ? (
        <Button size="sm" icon="Bookmark" onClick={() => onSave?.(current)}>
          {saveLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** One line that turns date phrases, @person, #tag, /kind and ~scope into chips; Enter saves. */
export function QuickAdd({
  label,
  placeholder: hint,
  value,
  onSubmit,
  referenceDate,
}: QuickAddProps): ReactElement {
  const t = useT();
  const [text, setText] = useState(value ?? "");
  const parsed = parseQuickAdd(text, referenceDate);
  return (
    <div className="flex flex-col gap-8 w-(--ui-alert) max-w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) {
            onSubmit?.(parsed);
            setText("");
          }
        }}
        className="flex items-center gap-8 h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring"
      >
        <Icon name="Plus" color="var(--color-text-secondary)" />
        <input
          aria-label={label ?? t("quickAdd.label")}
          placeholder={hint}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 min-w-0 border-0 bg-transparent outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
        />
        <Kbd>↵</Kbd>
      </form>
      {text ? (
        <div aria-live="polite" className="flex flex-wrap items-center gap-4">
          <span className="me-4 font-medium">{parsed.title || t("record.untitled")}</span>
          {parsed.tokens.map((token, i) => (
            <span key={`${token.type}-${i}`} className={chipClass}>
              <Icon name={token.icon} size={12} color="var(--color-text-secondary)" />
              {token.type === "kind" && isRecordKind(token.value) ? (
                <RecordKindGlyph kind={token.value} size={12} />
              ) : null}
              {token.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A 3-digit hex color as 6 digits, the form a color input takes. */
function expand(hex: string): string {
  return hex.length === 4
    ? `#${hex.slice(1).replace(/./g, "$&$&")}`.toUpperCase()
    : hex.toUpperCase();
}

/** A tenant color with live WCAG 2.2 AA checks; a color that fails any check cannot be saved. */
export function ColorPicker({ label, value, checks, onChange }: ColorPickerProps): ReactElement {
  const t = useT();
  const id = useFieldId(undefined);
  const [color, setColor] = useState(value);
  const valid = HEX.test(color);
  const [swatch, setSwatch] = useState(HEX.test(value) ? expand(value) : "");
  const results = valid
    ? checks.map((c) => {
        const fg = c.fgIsValue ? color : (c.fg ?? color);
        const bg = c.fgIsValue ? (c.bg ?? color) : color;
        const r = contrastRatio(fg, bg);
        return { ...c, ratio: r, pass: r >= (c.min ?? 4.5) };
      })
    : [];
  const allPass = valid && results.every((r) => r.pass);
  const set = (next: string) => {
    setColor(next);
    const ok = HEX.test(next);
    if (ok) setSwatch(expand(next));
    onChange?.(
      next,
      ok &&
        checks.every(
          (c) =>
            contrastRatio(
              c.fgIsValue ? next : (c.fg ?? next),
              c.fgIsValue ? (c.bg ?? next) : next,
            ) >= (c.min ?? 4.5),
        ),
    );
  };
  return (
    <div className={cx(fieldClass, "w-(--layout-property-column)")}>
      <span id={`${id}-label`} className={labelClass}>
        {label}
      </span>
      <div className="flex items-center gap-8">
        <input
          type="color"
          aria-labelledby={`${id}-label`}
          value={swatch}
          onChange={(e) => set(e.target.value.toUpperCase())}
          className="xos-hit h-control-md min-w-control-md p-0 rounded-control border border-border-control bg-transparent cursor-pointer pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse"
        />
        <input
          aria-label={t("color.hex", { label })}
          aria-invalid={valid ? undefined : true}
          aria-describedby={`${id}-status`}
          value={color}
          onChange={(e) => set(e.target.value)}
          className={cx(controlClass, "flex-1 font-mono")}
        />
      </div>
      <div id={`${id}-status`} aria-live="polite" className="flex flex-col gap-4">
        {valid ? (
          results.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-8">
              <span className="text-text-secondary">{r.label}</span>
              <span className="flex items-center gap-4">
                <span className="tabular-nums">
                  {t("contrast.ratio", { r: r.ratio.toFixed(2) })}
                </span>
                <span className={r.pass ? "text-success" : "text-danger"}>
                  <Icon name={r.pass ? "CircleCheck" : "CircleX"} size={14} />
                </span>
                <span>{r.pass ? t("contrast.pass") : t("contrast.fail")}</span>
              </span>
            </div>
          ))
        ) : (
          <div className={errorClass}>
            <Icon name="alert" size={12} />
            {t("color.invalid")}
          </div>
        )}
        {valid && !allPass ? <span className={helpClass}>{t("color.blocked")}</span> : null}
      </div>
    </div>
  );
}

/** Field-level changes with color plus strike-through or underline, so change never relies on color. */
export function DiffViewer({ caption, rows }: DiffViewerProps): ReactElement {
  const t = useT();
  const th = cx(
    "h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
  );
  const td = cx("h-row-default px-12 border-b border-border-subtle");
  return (
    <ScrollRegion label={caption ?? t("scroll.region")}>
      <table className="w-full border-collapse text-text-13">
        {caption ? <caption className="pb-8 text-start font-semibold">{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col" className={th}>
              {t("diff.field")}
            </th>
            <th scope="col" className={th}>
              {t("diff.before")}
            </th>
            <th scope="col" className={th}>
              {t("diff.after")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field}>
              <td className={cx(td, "text-text-secondary")}>{r.field}</td>
              <td className={td}>
                <del className="line-through text-danger-text">{r.before}</del>
              </td>
              <td className={td}>
                <ins className="underline underline-offset-(length:--space-2) text-success-text">
                  {r.after}
                </ins>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
