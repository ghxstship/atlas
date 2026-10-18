import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { Phone, blockClass } from "./Compass.shared.tsx";
import { type ScanSheetProps } from "./Compass.types.ts";

const SCAN_MODES = ["asset", "receiving", "credential"] as const;

/** The scan surface: mode switch, viewfinder, last result, running count and Done. */
export function ScanSheet({
  frame,
  mode,
  hint,
  count,
  countLabel,
  doneLabel,
  last,
  onModeChange,
  onDone,
  onNfc,
  onTorch,
  camera,
}: ScanSheetProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame}>
      <div className="flex flex-col">
        <div className="flex justify-center p-12">
          <SegmentedControl
            label={t("scan.mode")}
            value={mode}
            options={SCAN_MODES.map((m) => ({ value: m, label: t(`scan.${m}`) }))}
            onChange={(next) => onModeChange?.(next as ScanSheetProps["mode"])}
          />
        </div>
        <div
          aria-label={t("camera.viewfinder")}
          className="relative grid place-items-center h-(--ui-scan-view) overflow-hidden bg-camera-bg"
        >
          {camera ? <div className="absolute inset-0">{camera}</div> : null}
          <span className="relative w-(--ui-reticle-inline) h-(--ui-reticle-block) max-w-full box-border rounded-dialog ring-(length:--stroke-width-focus) ring-camera-ink" />
          <span className="absolute bottom-16 text-text-14 text-camera-ink">{hint}</span>
        </div>
        <div className="flex flex-col gap-12 p-16">
          {last ? (
            <div
              role="status"
              className={cx(
                "flex items-center gap-12 p-12 rounded-card bg-bg-surface ring-(length:--ui-hairline-half) ring-inset",
                last.ok ? "ring-success" : "ring-danger",
              )}
            >
              <Icon
                name={last.ok ? "CircleCheck" : "CircleX"}
                size={24}
                className={last.ok ? "text-success" : "text-danger"}
              />
              <div className="flex flex-col">
                <strong>{last.title}</strong>
                <span className="font-mono text-mono-12 text-text-secondary">{last.code}</span>
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span role="status">
              <strong className="text-heading-24 tabular-nums">{count}</strong> {countLabel}
            </span>
            <span className="flex items-center gap-8">
              <IconButton icon="Nfc" label={t("scan.nfc")} onClick={onNfc} />
              <IconButton icon="Flashlight" label={t("scan.torch")} onClick={onTorch} />
            </span>
          </div>
          <Button variant="primary" size="lg" className={blockClass} onClick={onDone}>
            {doneLabel}
          </Button>
        </div>
      </div>
    </Phone>
  );
}
