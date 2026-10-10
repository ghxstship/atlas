import { useId, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";

/** Label, control and help or error, shared by every form field. */
export const fieldClass = cx("flex flex-col gap-4 w-(--ui-field) max-w-full box-border");
export const labelClass = cx("text-text-12 font-medium text-text-secondary");
export const helpClass = cx("text-text-12 text-text-secondary max-w-full");
export const errorClass = cx("flex items-center gap-4 text-text-12 text-danger-text");

/** The bordered control box shared by inputs, selects and triggers. */
export const controlClass = cx(
  "h-control-md px-8 rounded-control border border-border-control bg-bg-surface text-text-primary",
  "font-sans text-text-13 placeholder:text-text-tertiary",
  "hover:not-focus-visible:border-text-tertiary focus-visible:border-transparent",
  "aria-invalid:border-danger disabled:opacity-disabled disabled:cursor-not-allowed",
  "pointer-coarse:min-h-target-coarse forced-colors:border-[CanvasText]",
  "in-data-[theme=sunlight]:border-stroke-focus",
);

export function useFieldId(id: string | undefined): string {
  const generated = useId();
  return id ?? `xos-${generated.replace(/:/g, "")}`;
}

/** Ids for the help or error line that a control's aria-describedby points to. */
export function describedBy(id: string, help: string | undefined, error: string | undefined) {
  return error ? `${id}-err` : help ? `${id}-help` : undefined;
}

export function widthStyle(width: number | string | undefined): CSSProperties | undefined {
  return width === undefined ? undefined : { inlineSize: width };
}

export interface FieldProps {
  id: string;
  label?: ReactNode | undefined;
  help?: ReactNode | undefined;
  error?: ReactNode | undefined;
  width?: number | string | undefined;
  /** Renders the label as a plain caption when the control is not labelable (a group). */
  labelFor?: boolean;
  children: ReactNode;
}

export function Field({
  id,
  label,
  help,
  error,
  width,
  labelFor = true,
  children,
}: FieldProps): ReactElement {
  return (
    <div className={fieldClass} style={widthStyle(width)}>
      {label ? (
        labelFor ? (
          <label className={labelClass} htmlFor={id} id={`${id}-label`}>
            {label}
          </label>
        ) : (
          <span className={labelClass} id={`${id}-label`}>
            {label}
          </span>
        )
      ) : null}
      {children}
      {error ? (
        <div className={errorClass} id={`${id}-err`}>
          <Icon name="alert" size={12} />
          {error}
        </div>
      ) : help ? (
        <div className={helpClass} id={`${id}-help`}>
          {help}
        </div>
      ) : null}
    </div>
  );
}
