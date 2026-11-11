import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import {
  controlClass,
  errorClass,
  fieldClass,
  helpClass,
  labelClass,
  useFieldId,
} from "../Field/Field.tsx";
import { type ColorCheck, type ColorPickerProps } from "./Editing.types.ts";
import { contrastRatio, overlaid } from "./contrastRatio.tsx";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A 3-digit hex color as 6 digits, the form a color input takes. */
function expand(hex: string): string {
  return hex.length === 4
    ? `#${hex.slice(1).replace(/./g, "$&$&")}`.toUpperCase()
    : hex.toUpperCase();
}

/** The ratio of one check for a color: the color as foreground or background, under any overlay. */
function measure(check: ColorCheck, color: string): number {
  const fg = check.fgIsValue ? color : (check.fg ?? color);
  const fill = check.fgIsValue ? (check.bg ?? color) : color;
  const bg = check.overlay ? overlaid(fill, check.overlay.color, check.overlay.opacity) : fill;
  return contrastRatio(fg, bg);
}

/** A tenant color with live WCAG 2.2 AA checks; a color that fails any check cannot be saved. */
export function ColorPicker({
  label,
  value,
  checks,
  onChange,
  disabled,
  help,
  error,
  id: idProp,
}: ColorPickerProps): ReactElement {
  const t = useT();
  const id = useFieldId(idProp);
  const [color, setColor] = useState(value);
  const valid = HEX.test(color);
  const [swatch, setSwatch] = useState(HEX.test(value) ? expand(value) : "");
  const results = valid
    ? checks.map((c) => {
        const r = measure(c, color);
        return { ...c, ratio: r, pass: r >= (c.min ?? 4.5) };
      })
    : [];
  const allPass = valid && results.every((r) => r.pass);
  const set = (next: string) => {
    setColor(next);
    const ok = HEX.test(next);
    if (ok) setSwatch(expand(next));
    onChange?.(next, ok && checks.every((c) => measure(c, next) >= (c.min ?? 4.5)));
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
          disabled={disabled}
          onChange={(e) => set(e.target.value.toUpperCase())}
          className="xos-hit h-control-md min-w-control-md p-0 rounded-control border border-border-control bg-transparent cursor-pointer pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse disabled:opacity-disabled disabled:cursor-not-allowed"
        />
        <input
          id={id}
          spellCheck={false}
          aria-label={t("color.hex", { label })}
          aria-invalid={valid && !error ? undefined : true}
          aria-describedby={`${id}-status${help ? ` ${id}-help` : ""}`}
          value={color}
          disabled={disabled}
          onChange={(e) => set(e.target.value.trim())}
          className={cx(controlClass, "flex-1 font-mono")}
        />
      </div>
      {help ? (
        <span id={`${id}-help`} className={helpClass}>
          {help}
        </span>
      ) : null}
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
        {error ? (
          <div className={errorClass} role="alert">
            <Icon name="alert" size={12} />
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
