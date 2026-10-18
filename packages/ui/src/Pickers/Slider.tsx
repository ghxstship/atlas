import { useState, type ReactElement } from "react";
import { Slider as RSlider } from "radix-ui";
import { useFormat, useT } from "../lib/context.tsx";
import { fieldClass, labelClass, useFieldId } from "../Field/Field.tsx";
import { type SliderProps } from "./Pickers.types.ts";

/** A value in a bounded range on Radix Slider, always showing the current value beside its label. */
export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  unit,
  onChange,
  id,
}: SliderProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const fmt = useFormat();
  const [current, setCurrent] = useState(value);
  const shown = unit
    ? t("slider.value", { value: fmt.number(current), unit })
    : fmt.number(current);
  return (
    <div className={fieldClass}>
      <div className="flex justify-between text-text-12">
        <span id={`${fieldId}-label`} className={labelClass}>
          {label}
        </span>
        <output htmlFor={fieldId} className="tabular-nums text-text-secondary">
          {shown}
        </output>
      </div>
      <RSlider.Root
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([v]) => {
          if (v === undefined) return;
          setCurrent(v);
          onChange?.(v);
        }}
        className="relative flex items-center h-control-md touch-none select-none pointer-coarse:min-h-target-coarse"
      >
        <RSlider.Track className="relative grow h-(--space-4) rounded-pill bg-bg-hover overflow-hidden">
          <RSlider.Range className="absolute h-full bg-accent" />
        </RSlider.Track>
        <RSlider.Thumb
          id={fieldId}
          aria-labelledby={`${fieldId}-label`}
          aria-valuetext={shown}
          className="block size-(--space-16) rounded-full bg-text-primary ring-(length:--stroke-width-focus) ring-bg-canvas cursor-grab"
        />
      </RSlider.Root>
    </div>
  );
}
