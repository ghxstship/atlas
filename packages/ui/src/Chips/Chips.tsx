import type { ReactElement, ReactNode } from "react";
import type {
  BadgeProps as ReferenceBadgeProps,
  DepartmentChipProps as ReferenceDepartmentChipProps,
  PhaseChipProps as ReferencePhaseChipProps,
  PropertyChipProps as ReferencePropertyChipProps,
  RecordKindChipProps as ReferenceRecordKindChipProps,
  StateChipProps as ReferenceStateChipProps,
  TagProps as ReferenceTagProps,
  URIDChipProps as ReferenceURIDChipProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { DepartmentGlyph, PhaseGlyph, RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";

export type StateChipProps = ReferenceStateChipProps;
export type PhaseChipProps = ReferencePhaseChipProps;
export type DepartmentChipProps = ReferenceDepartmentChipProps;
export type URIDChipProps = ReferenceURIDChipProps;
export type RecordKindChipProps = ReferenceRecordKindChipProps;
export type PropertyChipProps = ReferencePropertyChipProps;
export type TagProps = ReferenceTagProps;
export type BadgeProps = ReferenceBadgeProps & { className?: string };

/** The chip shape shared by every chip and property: 22 px, hairline border, surface ground. */
export const chipClass = cx(
  "inline-flex items-center gap-4 h-(--ui-chip) px-6 rounded-chip border border-border-subtle",
  "bg-bg-surface text-text-primary font-sans text-text-12 whitespace-nowrap",
  "transition-colors duration-fast ease-standard forced-colors:border-[CanvasText]",
);

const buttonChipClass = cx("xos-hit cursor-pointer hover:bg-bg-hover active:brightness-90");

/** The mono code beside a plain name; codes never appear alone. */
export const codeClass = cx(
  "font-mono text-text-11 text-text-secondary px-4 rounded-chip bg-bg-hover",
);

function Chip({
  onClick,
  title,
  children,
}: {
  onClick?: (() => void) | undefined;
  title?: string;
  children: ReactNode;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        className={cx(chipClass, buttonChipClass)}
        onClick={onClick}
        title={title}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={chipClass} title={title}>
      {children}
    </span>
  );
}

/** Record state as icon plus label; clickable chips open the state menu. `compact` keeps the label for assistive technology only. */
export function StateChip({
  state,
  label,
  compact = false,
  onClick,
}: StateChipProps): ReactElement {
  return (
    <Chip onClick={onClick}>
      <StateIcon state={state} />
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </Chip>
  );
}

/** Gate number and phase name (`Gate 3 · Advance`); the code is never shown alone. */
export function PhaseChip({ gate, name, code }: PhaseChipProps): ReactElement {
  const t = useT();
  return (
    <Chip title={code}>
      <PhaseGlyph code={code} size={14} color="var(--color-text-secondary)" />
      <span>{t("phase.gateName", { n: gate, name })}</span>
    </Chip>
  );
}

/** Department name with its code in a mono chip. */
export function DepartmentChip({ name, code }: DepartmentChipProps): ReactElement {
  return (
    <Chip>
      <DepartmentGlyph code={code} size={14} color="var(--color-text-secondary)" />
      <span>{name}</span>
      <span className={codeClass}>{code}</span>
    </Chip>
  );
}

/** Catalog element name with its URID in a mono chip. */
export function URIDChip({ name, urid }: URIDChipProps): ReactElement {
  return (
    <Chip>
      <span>{name}</span>
      <span className={codeClass}>{urid}</span>
    </Chip>
  );
}

/** Record kind glyph and name. */
export function RecordKindChip({ kind, label }: RecordKindChipProps): ReactElement {
  return (
    <Chip>
      <RecordKindGlyph kind={kind} size={14} color="var(--color-text-secondary)" />
      <span>{label ?? kind}</span>
    </Chip>
  );
}

/** An inline property that edits in place when clickable. */
export function PropertyChip({ label, value, icon, onClick }: PropertyChipProps): ReactElement {
  return (
    <Chip onClick={onClick}>
      {icon ? <Icon name={icon} size={14} color="var(--color-text-secondary)" /> : null}
      {label ? <span className="text-text-secondary">{label}</span> : null}
      <span>{value}</span>
    </Chip>
  );
}

const TAG_DOT: Record<NonNullable<TagProps["tone"]>, string> = {
  neutral: cx("bg-text-tertiary"),
  accent: cx("bg-accent"),
  success: cx("bg-success"),
  warning: cx("bg-warning"),
  danger: cx("bg-danger"),
};

/** A status word with a colored dot; the word carries the meaning. */
export function Tag({ tone = "neutral", children }: TagProps): ReactElement {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-4 h-(--ui-tag) px-6 rounded-chip bg-bg-hover text-text-secondary",
        "text-text-12 font-medium whitespace-nowrap forced-colors:border",
      )}
    >
      <span
        aria-hidden="true"
        className={cx("size-(--ui-dot) rounded-full flex-none", TAG_DOT[tone])}
      />
      {children}
    </span>
  );
}

const BADGE_TONE: Record<NonNullable<BadgeProps["tone"]>, string> = {
  neutral: cx("bg-bg-hover text-text-secondary"),
  accent: cx("bg-accent text-accent-text-on"),
  danger: cx("bg-danger text-danger-text-on"),
};

/** A count pill; above 99 it reads 99+. `label` names the count for assistive technology. */
export function Badge({ count, tone = "neutral", label, className }: BadgeProps): ReactElement {
  const text = count > 99 ? "99+" : String(count);
  return (
    <span
      className={cx(
        "inline-grid place-items-center min-w-(--ui-kbd) h-(--ui-kbd) px-6 rounded-pill",
        "text-text-11 font-semibold tabular-nums",
        BADGE_TONE[tone],
        className,
      )}
      {...(label ? { role: "img", "aria-label": label } : {})}
    >
      {text}
    </span>
  );
}
