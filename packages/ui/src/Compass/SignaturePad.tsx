import { useEffect, useRef, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { compassText } from "./Compass.shared.tsx";
import { type SignaturePadProps } from "./Compass.types.ts";

/** A drawn signature with its attestation; pointer input covers finger, stylus and mouse. */
export function SignaturePad({ label, attestation, onChange }: SignaturePadProps): ReactElement {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let down = false;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = getComputedStyle(canvas).color;
    const pos = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [
        ((e.clientX - r.left) * canvas.width) / (r.width || 1),
        ((e.clientY - r.top) * canvas.height) / (r.height || 1),
      ];
    };
    canvas.onpointerdown = (e) => {
      down = true;
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    canvas.onpointermove = (e) => {
      if (!down) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    };
    canvas.onpointerup = canvas.onpointerleave = () => {
      if (!down) return;
      down = false;
      onChangeRef.current?.(canvas.toDataURL("image/png"));
    };
  }, []);
  const clear = () => {
    const canvas = ref.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    onChange?.(null);
  };
  return (
    <div className={cx("xos-compass flex flex-col gap-6 w-(--ui-field) max-w-full", compassText)}>
      <span className="text-label-13 font-medium">{label}</span>
      <canvas
        ref={ref}
        width={720}
        height={240}
        role="img"
        aria-label={t("signature.area")}
        className="w-full h-(--ui-sigpad) bg-bg-surface border border-dashed border-border-strong rounded-card touch-none cursor-crosshair text-text-primary"
      />
      <div className="flex items-center justify-between gap-8">
        <span className="text-text-12 text-text-secondary">{attestation}</span>
        <Button size="sm" variant="ghost" onClick={clear}>
          {t("action.clear")}
        </Button>
      </div>
    </div>
  );
}
