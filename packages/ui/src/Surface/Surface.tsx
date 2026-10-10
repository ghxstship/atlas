import type { ReactElement } from "react";
import type {
  CardProps as ReferenceCardProps,
  DividerProps as ReferenceDividerProps,
  SkeletonProps as ReferenceSkeletonProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";

export type CardProps = ReferenceCardProps & { className?: string };
export type DividerProps = ReferenceDividerProps;
export type SkeletonProps = ReferenceSkeletonProps;

export const cardClass = cx(
  "bg-bg-raised border border-border-subtle rounded-card forced-colors:border-[CanvasText]",
  "print:bg-paper print:text-paper-ink print:shadow-none",
);
export const cardHeadClass = cx(
  "flex items-center justify-between gap-8 px-16 py-12 border-b border-border-subtle",
);
export const cardBodyClass = cx("flex flex-col gap-12 p-16");
export const cardFootClass = cx(
  "flex items-center justify-end gap-8 px-16 py-12 border-t border-border-subtle",
);

/** A raised region with an optional title, meta and footer. `interactive` strengthens the border on hover. */
export function Card({
  title,
  meta,
  footer,
  interactive = false,
  children,
  className,
}: CardProps): ReactElement {
  return (
    <section className={cx(cardClass, interactive && "hover:border-border-strong", className)}>
      {title ? (
        <header className={cardHeadClass}>
          <strong className="font-semibold">{title}</strong>
          {meta ? <span className="text-text-secondary">{meta}</span> : null}
        </header>
      ) : null}
      <div className={cardBodyClass}>{children}</div>
      {footer ? <footer className={cardFootClass}>{footer}</footer> : null}
    </section>
  );
}

/** A hairline rule, or a labeled separator between groups. */
export function Divider({ label }: DividerProps): ReactElement {
  if (!label) return <hr className="h-(--stroke-width-hairline) my-8 border-0 bg-border-subtle" />;
  return (
    <div
      role="separator"
      aria-label={label}
      className={cx(
        "flex items-center gap-8 my-8 text-text-11 text-text-tertiary",
        "before:h-(--stroke-width-hairline) before:flex-1 before:bg-border-subtle after:h-(--stroke-width-hairline) after:flex-1 after:bg-border-subtle",
      )}
    >
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

/** Reserves space for streamed content; stops pulsing under reduced motion. */
export function Skeleton({ width, height }: SkeletonProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="xos-anim-pulse block rounded-chip bg-bg-hover"
      style={{
        inlineSize: width ?? "var(--ui-skeleton-inline)",
        blockSize: height ?? "var(--ui-skeleton-block)",
      }}
    />
  );
}
