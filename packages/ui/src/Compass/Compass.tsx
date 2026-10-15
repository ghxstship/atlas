import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import type {
  ChecklistRunnerProps as ReferenceChecklistRunnerProps,
  ClockButtonProps as ReferenceClockButtonProps,
  DaySheetViewProps as ReferenceDaySheetViewProps,
  ForceUpdateScreenProps as ReferenceForceUpdateScreenProps,
  LiveActivityProps as ReferenceLiveActivityProps,
  OfflineBannerProps as ReferenceOfflineBannerProps,
  PhotoCaptureProps as ReferencePhotoCaptureProps,
  QuickIncidentSheetProps as ReferenceQuickIncidentSheetProps,
  ScanSheetProps as ReferenceScanSheetProps,
  ShiftCardProps as ReferenceShiftCardProps,
  SignaturePadProps as ReferenceSignaturePadProps,
  SyncConflictSheetProps as ReferenceSyncConflictSheetProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { StateChip, Tag } from "../Chips/Chips.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { Textarea } from "../Forms/Forms.tsx";

/**
 * Compass components on the web (RRR-75): the same surfaces Compass draws natively in
 * @xos/ui-native, for Atlas previews, the Gateway crew view and Storybook. Each one marks its root
 * `xos-compass`, which raises every target to touch-min (48 pt). Props are the reference contracts
 * plus the callbacks a product screen needs; `frame` draws the documentation phone frame and is for
 * previews only.
 */

export type ClockButtonProps = ReferenceClockButtonProps;
export type ScanSheetProps = ReferenceScanSheetProps & {
  onModeChange?: (mode: ReferenceScanSheetProps["mode"]) => void;
  onDone?: () => void;
  onNfc?: () => void;
  onTorch?: () => void;
  /** The live camera feed, drawn inside the viewfinder under the reticle. */
  camera?: ReactNode;
};
export type OfflineBannerProps = ReferenceOfflineBannerProps;
export type QuickIncidentSheetProps = ReferenceQuickIncidentSheetProps & {
  onSelect?: (label: string) => void;
};
export type ChecklistRunnerProps = ReferenceChecklistRunnerProps & {
  onResult?: (code: string, result: "pass" | "fail") => void;
  onAddPhoto?: (code: string) => void;
  onNoteChange?: (code: string, note: string) => void;
};
export type ShiftCardProps = ReferenceShiftCardProps;
export type DaySheetViewProps = ReferenceDaySheetViewProps & {
  onCall?: (name: string) => void;
  onMessage?: (name: string) => void;
};
export type SignaturePadProps = ReferenceSignaturePadProps & {
  /** A PNG data URL of the signature, or null after Clear. */
  onChange?: (signature: string | null) => void;
};
export type PhotoCaptureProps = ReferencePhotoCaptureProps & {
  onCapture?: () => void;
  onAnnotate?: () => void;
  onDone?: () => void;
  camera?: ReactNode;
};
export type LiveActivityProps = ReferenceLiveActivityProps & {
  /** Break, or End Break while on break. */
  onToggleBreak?: () => void;
  onClockOut?: () => void;
};
export type ForceUpdateScreenProps = ReferenceForceUpdateScreenProps & {
  onUpdate?: () => void;
};
export type SyncConflictSheetProps = ReferenceSyncConflictSheetProps & {
  onKeep?: (choice: "mine" | "theirs") => void;
};

const compassText = "font-sans text-text-16 text-text-primary";
const blockClass = "w-full justify-center";

function Phone({
  frame,
  tall,
  children,
}: {
  frame?: boolean | undefined;
  tall?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cx(
        "xos-compass",
        compassText,
        frame &&
          "flex flex-col justify-end w-(--ui-tabbar) max-w-full box-border overflow-hidden bg-bg-canvas border border-border-subtle rounded-device",
        frame && tall && "min-h-(--ui-photo-view)",
      )}
    >
      {children}
    </div>
  );
}

function SheetFrame({
  title,
  step,
  children,
}: {
  title: string;
  step?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="flex flex-col gap-16 px-16 pt-8 pb-24 bg-bg-raised rounded-t-dialog shadow-dialog"
    >
      <span
        aria-hidden="true"
        className="self-center w-(--ui-grabber-inline) h-(--ui-grabber-block) rounded-pill bg-border-strong"
      />
      <header className="flex items-baseline justify-between">
        <strong className="text-heading-20 font-semibold">{title}</strong>
        {step ? <span className="text-text-secondary tabular-nums">{step}</span> : null}
      </header>
      {children}
    </div>
  );
}

const CLOCK_STATE: Record<NonNullable<ClockButtonProps["state"]>, string> = {
  out: "bg-accent text-accent-text-on",
  on: "bg-bg-raised text-text-primary ring-(length:--stroke-width-focus) ring-inset ring-success",
  break:
    "bg-bg-raised text-text-primary ring-(length:--stroke-width-focus) ring-inset ring-warning",
  blocked:
    "bg-bg-surface text-text-secondary ring-(length:--stroke-width-hairline) ring-inset ring-border-strong cursor-not-allowed",
};

/** The Today screen's one primary control; it changes with the person's state. */
export function ClockButton({
  state = "out",
  label,
  detail,
  timer,
  geofence,
  geofenceOk,
  onClick,
}: ClockButtonProps): ReactElement {
  const blocked = state === "blocked";
  return (
    <div
      className={cx(
        "xos-compass flex flex-col items-stretch gap-8 w-(--ui-compass-card) max-w-full",
        compassText,
      )}
    >
      {geofence ? (
        <span className="inline-flex items-center gap-6 text-text-14 text-text-secondary">
          <Icon name="MapPin" size={16} className={geofenceOk ? "text-success" : "text-warning"} />
          {geofence}
        </span>
      ) : null}
      <button
        type="button"
        aria-disabled={blocked ? true : undefined}
        onClick={blocked ? undefined : onClick}
        className={cx(
          "flex flex-col items-center justify-center gap-4 w-full min-h-(--ui-compass-thumb) p-16 border-0 rounded-dialog",
          "text-heading-20 font-semibold cursor-pointer",
          "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          CLOCK_STATE[state],
        )}
      >
        {timer ? <span className="text-heading-32 tabular-nums">{timer}</span> : null}
        <span>{label}</span>
        {detail ? <small className="text-text-14 font-regular">{detail}</small> : null}
      </button>
    </div>
  );
}

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

/** Offline state with the count of queued writes (Section 13). */
export function OfflineBanner({ message, queued, onView }: OfflineBannerProps): ReactElement {
  const t = useT();
  return (
    <div
      role="status"
      className={cx(
        "xos-compass flex items-center gap-8 w-(--ui-tabbar) max-w-full box-border px-12 py-8",
        "bg-bg-surface border border-warning rounded-card text-text-14 text-text-primary",
      )}
    >
      <Icon name="WifiOff" size={16} className="text-warning" />
      <span className="flex-1">{message}</span>
      <span className="inline-flex items-center h-(--ui-chip) px-6 rounded-chip bg-bg-hover text-text-12 font-medium tabular-nums">
        {t("offline.queued", { n: queued })}
      </span>
      {onView ? (
        <Button size="sm" variant="ghost" onClick={onView}>
          {t("action.view")}
        </Button>
      ) : null}
    </div>
  );
}

/** Step one of the three-step incident report: choose the type from a grid. */
export function QuickIncidentSheet({
  frame,
  location,
  types,
  onSelect,
}: QuickIncidentSheetProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame}>
      <SheetFrame title={t("incident.title")} step={t("count.step", { n: 1, total: 3 })}>
        <div className="grid grid-cols-3 gap-8">
          {types.map((type) => (
            <button
              key={type.label}
              type="button"
              onClick={() => onSelect?.(type.label)}
              className={cx(
                "flex flex-col items-center justify-center gap-8 min-h-(--ui-compass-thumb) p-8",
                "border rounded-card bg-bg-surface text-text-primary text-text-14 font-medium cursor-pointer",
                "active:bg-bg-hover forced-colors:border-[CanvasText]",
                "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                type.critical ? "border-danger" : "border-border-control",
              )}
            >
              <Icon name={type.icon} size={28} className={type.critical ? "text-danger" : ""} />
              <span>{type.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-6 text-text-secondary">
          <Icon name="MapPin" size={16} />
          {location}
        </div>
        <p className="m-0 text-text-12 text-text-secondary">{t("incident.help")}</p>
      </SheetFrame>
    </Phone>
  );
}

function BigChoice({
  pass,
  on,
  label,
  onClick,
}: {
  pass: boolean;
  on: boolean;
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "flex flex-col items-center justify-center gap-4 h-(--ui-compass-thumb) border-0 rounded-dialog",
        "text-heading-20 font-semibold cursor-pointer text-text-primary forced-colors:border forced-colors:border-[CanvasText]",
        "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        on
          ? cx(
              "bg-bg-hover ring-(length:--stroke-width-focus) ring-inset",
              pass ? "ring-success" : "ring-danger",
            )
          : "bg-bg-surface ring-(length:--ui-hairline-half) ring-inset ring-border-control",
      )}
    >
      <Icon
        name={pass ? "Check" : "X"}
        size={28}
        className={pass ? "text-success" : "text-danger"}
      />
      {label}
    </button>
  );
}

/** Inspection runner: one item per card, large Pass and Fail; a Fail asks for a photo and a note. */
export function ChecklistRunner({
  frame,
  title,
  index,
  items,
  onResult,
  onAddPhoto,
  onNoteChange,
}: ChecklistRunnerProps): ReactElement {
  const t = useT();
  const [results, setResults] = useState(() => items.map((i) => i.result));
  useEffect(() => setResults(items.map((i) => i.result)), [items]);
  const item = items[index];
  const done = results.filter(Boolean).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  const result = results[index] ?? null;
  const choose = (next: "pass" | "fail") => {
    if (!item) return;
    setResults((prev) => prev.map((r, i) => (i === index ? next : r)));
    onResult?.(item.code, next);
  };
  return (
    <Phone frame={frame}>
      <div className="flex flex-col gap-12 p-16">
        <div className="flex justify-between text-text-12 text-text-secondary">
          <strong className="text-text-primary">{title}</strong>
          <span className="tabular-nums">
            {t("count.of", { n: index + 1, total: items.length })}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-4 rounded-pill bg-bg-hover overflow-hidden"
        >
          <div
            className="h-full rounded-pill bg-accent forced-colors:bg-[CanvasText]"
            style={{ inlineSize: `${percent}%` }}
          />
        </div>
        {item ? (
          <article className="flex flex-col gap-8 p-20 min-h-(--ui-compass-card-min) bg-bg-raised border border-border-subtle rounded-dialog">
            <span className="font-mono text-mono-12 text-text-secondary">{item.code}</span>
            <strong className="text-heading-20 font-semibold">{item.label}</strong>
            {item.help ? <span className="text-text-secondary">{item.help}</span> : null}
            {result === "fail" ? (
              <div className="flex flex-col gap-8">
                <Button icon="Camera" size="lg" onClick={() => onAddPhoto?.(item.code)}>
                  {t("inspection.addPhoto")}
                </Button>
                <Textarea
                  label={t("inspection.whatFailed")}
                  width="100%"
                  onChange={(e) => onNoteChange?.(item.code, e.target.value)}
                />
              </div>
            ) : null}
          </article>
        ) : null}
        <div className="grid grid-cols-2 gap-12">
          <BigChoice
            pass={false}
            on={result === "fail"}
            label={t("inspection.fail")}
            onClick={() => choose("fail")}
          />
          <BigChoice
            pass
            on={result === "pass"}
            label={t("inspection.pass")}
            onClick={() => choose("pass")}
          />
        </div>
      </div>
    </Phone>
  );
}

function Fact({ icon, children }: { icon: string; children: ReactNode }): ReactElement {
  return (
    <span className="flex items-center gap-6">
      <Icon name={icon} size={16} className="text-text-secondary" />
      {children}
    </span>
  );
}

/** A shift with its state, countdown, role, date, time and place, and up to two actions. */
export function ShiftCard({
  state,
  stateLabel,
  countdown,
  role,
  date,
  time,
  place,
  actions,
}: ShiftCardProps): ReactElement {
  return (
    <article
      className={cx(
        "xos-compass flex flex-col gap-12 w-(--ui-compass-card) max-w-full box-border p-16",
        "bg-bg-raised border border-border-subtle rounded-dialog forced-colors:border-[CanvasText]",
        compassText,
      )}
    >
      <header className="flex items-center justify-between gap-8">
        <StateChip state={state} label={stateLabel} />
        {countdown ? <span className="text-text-secondary tabular-nums">{countdown}</span> : null}
      </header>
      <strong className="text-heading-16 font-semibold">{role}</strong>
      <div className="flex flex-col gap-6">
        <Fact icon="Calendar">{date}</Fact>
        <Fact icon="Clock">
          <span className="tabular-nums">{time}</span>
        </Fact>
        <Fact icon="MapPin">{place}</Fact>
      </div>
      {actions ? (
        <footer className="flex items-center gap-8 *:flex-1 *:justify-center *:min-h-touch-min">
          {actions}
        </footer>
      ) : null}
    </article>
  );
}

/** The day sheet: schedule with the current entry marked, and contacts with call and message. */
export function DaySheetView({
  frame,
  date,
  title,
  venue,
  entries,
  contacts,
  onCall,
  onMessage,
}: DaySheetViewProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame}>
      <div className="flex flex-col gap-16 p-16">
        <header className="flex flex-col gap-2">
          <span className="text-text-secondary">{date}</span>
          <strong className="text-heading-20 font-semibold">{title}</strong>
          <span className="text-text-secondary">{venue}</span>
        </header>
        <ol className="m-0 p-0 list-none">
          {entries.map((e, i) => (
            <li
              key={i}
              aria-current={e.now ? "time" : undefined}
              className={cx(
                "grid grid-cols-[var(--ui-daysheet-time)_1fr_auto] items-center min-h-touch-min border-b border-border-subtle",
                e.now && "font-semibold",
              )}
            >
              <span className="text-text-secondary tabular-nums">{e.time}</span>
              <span>{e.label}</span>
              {e.now ? <Tag tone="accent">{t("daysheet.now")}</Tag> : null}
            </li>
          ))}
        </ol>
        <section className="flex flex-col">
          <h4 className="m-0 text-text-12 font-medium text-text-secondary">
            {t("daysheet.contacts")}
          </h4>
          {contacts.map((c) => (
            <div key={c.name} className="flex items-center gap-8 py-6">
              <Avatar name={c.name} />
              <div className="flex flex-col flex-1">
                <strong>{c.name}</strong>
                <span className="text-text-secondary">{c.role}</span>
              </div>
              <IconButton
                icon="Phone"
                variant="secondary"
                label={t("contact.call", { name: c.name })}
                onClick={() => onCall?.(c.name)}
              />
              <IconButton
                icon="MessageSquare"
                variant="secondary"
                label={t("contact.message", { name: c.name })}
                onClick={() => onMessage?.(c.name)}
              />
            </div>
          ))}
        </section>
      </div>
    </Phone>
  );
}

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

/** The lock screen Live Activity and the home screen widget layouts. */
export function LiveActivity({
  label,
  elapsed,
  place,
  nextShift,
  nextTime,
  onBreak = false,
  onToggleBreak,
  onClockOut,
}: LiveActivityProps): ReactElement {
  const t = useT();
  return (
    <div className={cx("xos-compass flex flex-col gap-12", compassText)}>
      <div
        role="group"
        aria-label={t("live.label")}
        className="flex flex-col gap-8 w-(--ui-compass-card) max-w-full box-border p-16 rounded-widget bg-bg-raised shadow-menu"
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-6">
            <Icon
              name={onBreak ? "Coffee" : "Clock"}
              size={16}
              className={onBreak ? "text-warning" : "text-success"}
            />
            <strong>{label}</strong>
          </span>
          <span className="text-heading-24 font-semibold tabular-nums">{elapsed}</span>
        </div>
        <span className="text-text-secondary">{place}</span>
        <div className="flex gap-8">
          <Button size="lg" className={blockClass} onClick={onToggleBreak}>
            {t(onBreak ? "clock.endBreak" : "clock.break")}
          </Button>
          <Button size="lg" variant="primary" className={blockClass} onClick={onClockOut}>
            {t("clock.out")}
          </Button>
        </div>
      </div>
      <div
        role="group"
        aria-label={t("widget.label")}
        className="flex flex-col justify-end gap-2 size-(--ui-widget) box-border p-16 rounded-widget bg-bg-raised shadow-menu"
      >
        <span className="text-text-secondary">{t("widget.nextShift")}</span>
        <strong>{nextShift}</strong>
        <span className="tabular-nums">{nextTime}</span>
      </div>
    </div>
  );
}

/** Blocks the app below the forced minimum version (Section 5.1) until the person updates. */
export function ForceUpdateScreen({
  frame,
  message,
  version,
  onUpdate,
}: ForceUpdateScreenProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame} tall>
      <div className="flex flex-1 flex-col items-center justify-center gap-12 px-24 py-32 text-center">
        <Icon name="Smartphone" size={28} className="text-text-secondary" />
        <strong className="text-heading-20 font-semibold">{t("update.title")}</strong>
        <p className="m-0 text-text-secondary">{message}</p>
        <span className="font-mono text-mono-12 text-text-secondary">{version}</span>
        <Button variant="primary" size="lg" className={blockClass} onClick={onUpdate}>
          {t("update.action")}
        </Button>
      </div>
    </Phone>
  );
}

/** Resolves an offline write that collided with a newer server value. */
export function SyncConflictSheet({
  frame,
  message,
  field,
  mine,
  mineMeta,
  theirs,
  theirsMeta,
  onKeep,
}: SyncConflictSheetProps): ReactElement {
  const t = useT();
  const [choice, setChoice] = useState<"mine" | "theirs">("mine");
  const name = useId();
  const options = [
    { value: "mine" as const, who: t("conflict.yours"), value_: mine, meta: mineMeta },
    { value: "theirs" as const, who: t("conflict.server"), value_: theirs, meta: theirsMeta },
  ];
  return (
    <Phone frame={frame}>
      <SheetFrame title={t("conflict.title")}>
        <p className="m-0 text-text-secondary">{message}</p>
        <span className="text-label-13 font-medium">{field}</span>
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              "flex items-center gap-12 p-12 border rounded-card cursor-pointer",
              choice === o.value ? "border-accent bg-bg-hover" : "border-border-control",
            )}
          >
            <input
              type="radio"
              name={name}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
              className="size-icon-20 accent-(--color-accent-default)"
            />
            <div className="flex flex-col">
              <span className="text-text-secondary">
                {o.who} · {o.meta}
              </span>
              <strong>{o.value_}</strong>
            </div>
          </label>
        ))}
        <Button variant="primary" size="lg" className={blockClass} onClick={() => onKeep?.(choice)}>
          {t("conflict.keep")}
        </Button>
      </SheetFrame>
    </Phone>
  );
}
