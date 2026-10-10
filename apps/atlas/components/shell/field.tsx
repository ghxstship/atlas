import type { ComponentProps, ReactNode } from "react";

/**
 * A labeled input with help and inline error, the minimum stand-in for @xos/ui Input until it lands
 * on main. The error is tied to the input with aria-describedby and aria-invalid.
 */
export function Field({
  id,
  label,
  help,
  error,
  className = "",
  ...input
}: Omit<ComponentProps<"input">, "id"> & {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | undefined;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <label htmlFor={id} className="text-label-13 font-medium text-text-primary">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary aria-invalid:border-danger"
        {...input}
      />
      {error ? (
        <p id={errorId} className="text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
      {help ? (
        <p id={helpId} className="text-text-12 text-text-secondary">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** A form-level message announced to screen readers. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-control border border-danger bg-bg-surface px-12 py-8 text-text-13 text-danger-text"
    >
      {children}
    </p>
  );
}
