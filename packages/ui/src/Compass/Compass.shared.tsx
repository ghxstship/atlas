import { type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export const compassText = "font-sans text-text-16 text-text-primary";

export const blockClass = "w-full justify-center";

export function Phone({
  frame,
  tall,
  children,
}: {
  frame?: boolean | undefined;
  tall?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cx(
        "xos-compass",
        compassText,
        frame &&
          "flex flex-col justify-end w-(--ui-tabbar) max-w-full box-border overflow-hidden bg-bg-canvas border border-border-subtle rounded-device",
        frame && tall && "min-h-(--ui-photo-view)",
      )}
    >
      {children}
    </div>
  );
}

export function SheetFrame({
  title,
  step,
  children,
}: {
  title: string;
  step?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="flex flex-col gap-16 px-16 pt-8 pb-24 bg-bg-raised rounded-t-dialog shadow-dialog"
    >
      <span
        aria-hidden="true"
        className="self-center w-(--ui-grabber-inline) h-(--ui-grabber-block) rounded-pill bg-border-strong"
      />
      <header className="flex items-baseline justify-between">
        <strong className="text-heading-20 font-semibold">{title}</strong>
        {step ? <span className="text-text-secondary tabular-nums">{step}</span> : null}
      </header>
      {children}
    </div>
  );
}
