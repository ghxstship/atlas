import { useState, type ChangeEvent, type ReactElement } from "react";
import type {
  CheckboxProps as ReferenceCheckboxProps,
  CurrencyInputProps as ReferenceCurrencyInputProps,
  InputProps as ReferenceInputProps,
  MoneyProps as ReferenceMoneyProps,
  NumberInputProps as ReferenceNumberInputProps,
  RadioProps as ReferenceRadioProps,
  SelectProps as ReferenceSelectProps,
  SwitchProps as ReferenceSwitchProps,
  TextareaProps as ReferenceTextareaProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { iconButtonClass } from "../Button/Button.tsx";
import {
  Field,
  controlClass,
  describedBy,
  helpClass,
  labelClass,
  useFieldId,
} from "../Field/Field.tsx";

export type InputProps = ReferenceInputProps;
export type TextareaProps = ReferenceTextareaProps;
export type SelectProps = ReferenceSelectProps & { id?: string; name?: string };
export type CheckboxProps = ReferenceCheckboxProps;
export type SwitchProps = ReferenceSwitchProps;
export type RadioProps = ReferenceRadioProps;
export type NumberInputProps = ReferenceNumberInputProps & {
  id?: string;
  min?: number;
  max?: number;
};
export type CurrencyInputProps = ReferenceCurrencyInputProps;
export type MoneyProps = ReferenceMoneyProps;

/** A labeled single-line field with help text or an inline error naming the field, problem and fix. */
export function Input({
  label,
  help,
  error,
  id,
  width,
  className,
  ...rest
}: InputProps): ReactElement {
  const fieldId = useFieldId(id);
  return (
    <Field id={fieldId} label={label} help={help} error={error} width={width}>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        {...rest}
        className={cx(controlClass, className)}
      />
    </Field>
  );
}

/** A multi-line field; grows by rows and resizes vertically. */
export function Textarea({
  label,
  help,
  error,
  id,
  width,
  className,
  rows = 3,
  ...rest
}: TextareaProps): ReactElement {
  const fieldId = useFieldId(id);
  return (
    <Field id={fieldId} label={label} help={help} error={error} width={width}>
      <textarea
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        {...rest}
        className={cx(controlClass, "h-auto py-6 resize-y leading-normal", className)}
      />
    </Field>
  );
}

/**
 * A native select styled to the system. The contract's onChange is a native select change event,
 * so the control stays a native select, which also gives the platform picker on touch devices.
 */
export function Select({
  label,
  help,
  error,
  value,
  placeholder: hint,
  options,
  disabled,
  onChange,
  id,
  name,
}: SelectProps): ReactElement {
  const fieldId = useFieldId(id);
  return (
    <Field id={fieldId} label={label} help={help} error={error}>
      <div className="relative">
        <select
          id={fieldId}
          name={name}
          className={cx(controlClass, "appearance-none w-full pe-24")}
          defaultValue={value ?? (hint ? "" : undefined)}
          disabled={disabled}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, help, error)}
        >
          {hint ? (
            <option value="" disabled>
              {hint}
            </option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
          <Icon name="ChevronsUpDown" size={14} />
        </span>
      </div>
    </Field>
  );
}

const checkLabelClass = cx("xos-check inline-flex items-center gap-8 cursor-pointer text-text-13");

/** A native checkbox with its label; the whole label is the target. */
export function Checkbox({ label, className, ...rest }: CheckboxProps): ReactElement {
  return (
    <label className={cx(checkLabelClass, className)}>
      <input type="checkbox" {...rest} className="xos-check-input" />
      {label}
    </label>
  );
}

/** An immediate on or off setting; a checkbox input with the switch role. */
export function Switch({ label, className, ...rest }: SwitchProps): ReactElement {
  return (
    <label className={cx(checkLabelClass, className)}>
      <input type="checkbox" role="switch" {...rest} className="xos-check-input" />
      {label}
    </label>
  );
}

/** A group of native radios in a fieldset; arrow keys move between options as the platform does. */
export function Radio({ label, name, value, options, onChange }: RadioProps): ReactElement {
  const groupName = useFieldId(name);
  return (
    <fieldset className="flex flex-col gap-8 m-0 p-0 border-0">
      <legend className={cx(labelClass, "mb-8")}>{label}</legend>
      {options.map((o) => (
        <label key={o.value} className={cx(checkLabelClass, "items-start")}>
          <input
            type="radio"
            name={groupName}
            value={o.value}
            defaultChecked={value === o.value}
            onChange={onChange}
            className="xos-check-input"
          />
          <span className="flex flex-col">
            <span>{o.label}</span>
            {o.help ? <span className={helpClass}>{o.help}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function parseNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** A number with units and steppers. Blank stays null, never 0; Arrow Up and Down step. */
export function NumberInput({
  label,
  help,
  value,
  unit,
  step = 1,
  placeholder: hint,
  onChange,
  id,
  min,
  max,
}: NumberInputProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const [current, setCurrent] = useState<number | null>(value ?? null);
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const set = (n: number | null) => {
    const next = n === null ? null : clamp(n);
    setCurrent(next);
    setText(next === null ? "" : String(next));
    onChange?.(next);
  };
  return (
    <Field id={fieldId} label={label} help={help}>
      <div className="flex items-center gap-4">
        <button
          type="button"
          className={iconButtonClass()}
          aria-label={t("number.decrease")}
          onClick={() => set((current ?? 0) - step)}
        >
          <Icon name="Minus" size={14} />
        </button>
        <input
          id={fieldId}
          className={cx(controlClass, "flex-1 min-w-0 text-end tabular-nums")}
          inputMode="decimal"
          value={text}
          placeholder={hint}
          aria-describedby={describedBy(fieldId, help, undefined)}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setText(e.target.value);
            const n = parseNumber(e.target.value);
            setCurrent(n);
            onChange?.(n);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              set((current ?? 0) + step);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              set((current ?? 0) - step);
            }
          }}
        />
        {unit ? <span className="text-text-12 text-text-tertiary">{unit}</span> : null}
        <button
          type="button"
          className={iconButtonClass()}
          aria-label={t("number.increase")}
          onClick={() => set((current ?? 0) + step)}
        >
          <Icon name="Plus" size={14} />
        </button>
      </div>
    </Field>
  );
}

/** An amount with tabular numerals, or Unpriced when null. A blank price is Unpriced; a zero is a claim. */
export function Money({ amount, currency, unpricedLabel }: MoneyProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  if (amount === null || amount === undefined) {
    return (
      <span className="text-text-secondary not-italic">{unpricedLabel ?? t("money.unpriced")}</span>
    );
  }
  return <span className="tabular-nums">{fmt.currency(amount, currency)}</span>;
}

/** A NULL-aware amount field: blank is unpriced and never coerced to 0. */
export function CurrencyInput({
  label,
  value,
  currency = "USD",
  help,
  unpricedLabel,
  id,
  onChange,
}: CurrencyInputProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const [blank, setBlank] = useState(value === null || value === undefined);
  const helpText = help ?? (blank ? t("money.blankHelp") : undefined);
  return (
    <Field id={fieldId} label={label} help={helpText}>
      <div className="flex items-center gap-6">
        <input
          id={fieldId}
          className={cx(controlClass, "flex-1 min-w-0 text-end tabular-nums")}
          inputMode="decimal"
          placeholder={unpricedLabel ?? t("money.unpriced")}
          defaultValue={value === null || value === undefined ? "" : String(value)}
          aria-describedby={describedBy(fieldId, helpText, undefined)}
          onChange={(e) => {
            setBlank(e.target.value.trim() === "");
            onChange?.(e);
          }}
        />
        <span className="text-text-12 text-text-tertiary">{currency}</span>
      </div>
    </Field>
  );
}
