import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Phone } from "./Compass.shared.tsx";
import { type PhotoCaptureProps } from "./Compass.types.ts";

/** Photo proof: viewfinder, thumbnails of what is taken, annotate, shutter and Done. */
export function PhotoCapture({
  frame,
  hint,
  count,
  onCapture,
  onAnnotate,
  onDone,
  camera,
}: PhotoCaptureProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame}>
      <div className="flex flex-col">
        <div
          role="img"
          aria-label={t("camera.viewfinder")}
          className="relative grid place-items-center h-(--ui-photo-view) overflow-hidden bg-camera-bg"
        >
          {camera ? <div className="absolute inset-0">{camera}</div> : null}
          <span className="absolute bottom-16 text-text-14 text-camera-ink">{hint}</span>
        </div>
        <div className="flex flex-col gap-12 p-16">
          <div className="flex flex-wrap gap-8">
            {Array.from({ length: count }, (_, i) => (
              <span
                key={i}
                role="img"
                aria-label={t("photo.n", { n: i + 1 })}
                className="grid place-items-center size-(--ui-thumb) rounded-card bg-bg-hover text-text-tertiary"
              >
                <Icon name="Image" size={16} />
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <IconButton
              icon="PenLine"
              variant="secondary"
              label={t("photo.annotate")}
              onClick={onAnnotate}
            />
            <button
              type="button"
              aria-label={t("photo.take")}
              onClick={onCapture}
              className={cx(
                "size-(--ui-shutter) rounded-full border-stroke-swatch border-text-primary bg-text-primary cursor-pointer",
                "ring-(length:--stroke-width-accent) ring-inset ring-bg-canvas",
                "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
              )}
            />
            <Button variant="primary" onClick={onDone}>
              {t("action.done")}
            </Button>
          </div>
        </div>
      </div>
    </Phone>
  );
}
