import { useState, type ChangeEvent, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { iconButtonClass } from "../Button/Button.tsx";
import { Field, controlClass, describedBy, useFieldId } from "../Field/Field.tsx";
import { type NumberInputProps } from "./Forms.types.ts";

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
