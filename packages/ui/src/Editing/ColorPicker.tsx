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
import { type ColorPickerProps } from "./Editing.types.ts";
import { contrastRatio } from "./contrastRatio.tsx";

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
