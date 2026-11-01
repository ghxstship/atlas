"use client";

import type { PlanPoint } from "@xos/data/places-geometry";
import { parsePointAnchor } from "@xos/data/places-geometry";
import {
  isLegacyPlan,
  type SitePlan,
  type SitePlanPin,
  type SitePlanShape,
  type SitePlanShapeTone,
  type Zone,
} from "@xos/data/places";
import { InlineAlert, Input, Select } from "@xos/ui";
import type { Route } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useEffect, useState, type KeyboardEvent } from "react";
import { addPinAction, movePinAction, saveSitePlanAction } from "@/app/[org]/places/actions";
import { ActionForm, useCopy } from "../kit/form";
import { formatLength, formatArea, type PlanUnits } from "./plan-units";
import type { PlanTool } from "./plan-tools";

/** The drawing tools load only on a Draft plan someone may change, or for a person who may annotate (ADR 0140). */
const PlanTools = dynamic(() => import("./plan-tools").then((m) => m.PlanTools), { ssr: false });

/** Only web addresses render as an image for a legacy plan; a stored path shows the drawing grid with its pins. */
function isWebImage(uri: string): boolean {
  return /^https?:\/\//.test(uri);
}

const percent = (ratio: number) => Math.round(ratio * 1000) / 10;

/** Token colors for each shape tone, so every overlay keeps its contrast in both themes. */
export const TONE_COLOR: Readonly<Record<SitePlanShapeTone, string>> = {
  Accent: "var(--color-accent-default)",
  Info: "var(--color-state-scheduled)",
  Success: "var(--color-success-text)",
  Warning: "var(--color-warning-text)",
  Danger: "var(--color-danger-text)",
  Neutral: "var(--color-text-primary)",
};

export interface PointNote {
  readonly threadId: string;
  readonly anchor: string;
  readonly resolved: boolean;
  readonly count: number;
}

/**
 * A site plan drawing with its pins and shapes (Section 11.15, site plan view; ADR 0140 D3 and D4). The canvas keeps
 * the stored drawing's proportions and draws an SVG overlay in the drawing's own pixels, so pins and shapes stay put at
 * any width. The drawing comes from /files/{version} like any file, so its download is logged (ADR 0116). A legacy
 * plan keeps the 16:10 frame its pins were placed on. The numbered legend and the point fields are the keyboard and
 * screen reader path; arrow keys nudge the selected point by 1%, with Shift by 0.1%.
 */
export function PlanCanvas({
  org,
  plan,
  shapes,
  zones,
  canWrite,
  canComment,
  notes,
  units,
  signsAtPins,
  openComments,
  showResolved,
  resolvedHref,
  threadHrefs,
}: {
  org: string;
  plan: SitePlan;
  shapes: readonly SitePlanShape[];
  zones: readonly Zone[];
  canWrite: boolean;
  canComment: boolean;
  notes: readonly PointNote[];
  units: PlanUnits;
  signsAtPins: Readonly<Record<string, readonly string[]>>;
  /** Open comment threads per pin and shape id. */
  openComments: Readonly<Record<string, number>>;
  showResolved: boolean;
  /** The same page with resolved point notes shown or hidden. */
  resolvedHref: string;
  /** Where the thread of each pin, shape and point note opens, by id. */
  threadHrefs: Readonly<Record<string, string>>;
}) {
  const t = useCopy("places");
  const locale = useLocale();
  const legacy = isLegacyPlan(plan);
  const drawing = plan.drawing;
  const shown = drawing && !drawing.unavailable ? drawing : null;
  const width = shown?.widthPx ?? 1600;
  const height = shown?.heightPx ?? 1000;
  const draft = plan.planState === "Draft";
  const [image, setImage] = useState<{
    url: string | null;
    error: string | null;
    mismatch: boolean;
  }>({
    url: null,
    error: null,
    mismatch: false,
  });
  const [tool, setTool] = useState<PlanTool>("select");
  const [points, setPoints] = useState<PlanPoint[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [legacyDraft, setLegacyDraft] = useState<{ x: number; y: number } | null>(null);
  const zoneName = new Map(zones.map((z) => [z.id, `${z.code} ${z.name}`]));

  useEffect(() => {
    if (!shown) return;
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/files/${shown.shownVersionId}`, {
        credentials: "same-origin",
      });
      if (cancelled) return;
      if (!response.ok) {
        setImage({
          url: null,
          error: response.status === 403 ? "drawingForbidden" : "drawingFailed",
          mismatch: false,
        });
        return;
      }
      url = URL.createObjectURL(await response.blob());
      if (!cancelled) setImage({ url, error: null, mismatch: false });
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [shown]);

  const editable = canWrite && draft && shown !== null && !image.mismatch;
  const toolsShown = (canWrite && draft && shown !== null) || (canComment && shown !== null);
  const pinNumber = new Map(plan.pins.map((p, i) => [p.id, i + 1]));
  const shapeNumber = new Map(shapes.map((s, i) => [s.id, plan.pins.length + i + 1]));
  const visibleNotes = notes.filter((n) => showResolved || !n.resolved);

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected === null || !points[selected]) return;
    const step = event.shiftKey ? 0.001 : 0.01;
    const delta: Record<string, PlanPoint> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    setPoints((current) =>
      current.map((p, i) =>
        i === selected
          ? [Math.min(1, Math.max(0, p[0] + d[0])), Math.min(1, Math.max(0, p[1] + d[1]))]
          : p,
      ),
    );
  };

  return (
    <div className="flex flex-col gap-16">
      {drawing?.unavailable ? (
        <InlineAlert tone="warning">
          {t(
            drawing.unavailable === "classified"
              ? "plans.drawing.classified"
              : "plans.drawing.removed",
          )}
        </InlineAlert>
      ) : null}
      {image.mismatch ? (
        <InlineAlert tone="warning">{t("plans.drawing.sizeMismatch")}</InlineAlert>
      ) : null}
      {image.error ? (
        <InlineAlert tone="danger">{t(`plans.drawing.${image.error}`)}</InlineAlert>
      ) : null}
      {legacy ? <InlineAlert tone="info">{t("plans.drawing.legacyNotice")}</InlineAlert> : null}
      {!draft ? (
        <InlineAlert tone="info">
          {t(plan.planState === "Archived" ? "plans.archivedStateNotice" : "plans.lockedNotice")}
        </InlineAlert>
      ) : null}
      <div
        role="group"
        aria-label={t("plans.drawingAlt", { title: plan.title })}
        tabIndex={selected !== null ? 0 : -1}
        onKeyDown={nudge}
        className="relative w-full overflow-hidden rounded-card border border-border-subtle bg-bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring"
        style={{ aspectRatio: `${width} / ${height}` }}
        data-testid="plan-canvas"
      >
        {shown && image.url ? (
          // The drawing is the plan's own stored file, read through /files so its download is logged.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt=""
            className="absolute inset-0 size-full"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth !== shown.widthPx || img.naturalHeight !== shown.heightPx) {
                setImage((s) => ({ ...s, mismatch: true }));
              }
            }}
          />
        ) : legacy && isWebImage(plan.imageUri) ? (
          // A legacy plan's image is user content at an arbitrary address, so next/image's domain list cannot cover it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={plan.imageUri} alt="" className="absolute inset-0 size-full object-contain" />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(var(--color-border-subtle)_var(--stroke-width-hairline),transparent_var(--stroke-width-hairline)),linear-gradient(90deg,var(--color-border-subtle)_var(--stroke-width-hairline),transparent_var(--stroke-width-hairline))] bg-[size:5%_8%]"
          />
        )}
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full"
        >
          {shapes.map((s) => (
            <ShapeMark
              key={s.id}
              shape={s}
              n={shapeNumber.get(s.id) ?? 0}
              width={width}
              height={height}
            />
          ))}
          {points.length > 0 ? (
            <DraftMark
              points={points}
              tool={tool}
              width={width}
              height={height}
              selected={selected}
            />
          ) : null}
        </svg>
        {canWrite && draft && legacy ? (
          <button
            type="button"
            aria-label={t("plans.placeHint")}
            className="absolute inset-0 cursor-crosshair bg-transparent"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setLegacyDraft({
                x: (e.clientX - box.left) / box.width,
                y: (e.clientY - box.top) / box.height,
              });
            }}
          />
        ) : null}
        {tool !== "select" ? (
          <button
            type="button"
            aria-label={t(`plans.tools.hint.${tool}`)}
            className="absolute inset-0 cursor-crosshair bg-transparent"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const p: PlanPoint = [
                Math.round(((e.clientX - box.left) / box.width) * 10000) / 10000,
                Math.round(((e.clientY - box.top) / box.height) * 10000) / 10000,
              ];
              const single = tool === "pin" || tool === "label" || tool === "annotate";
              const pair = tool === "scale";
              setPoints((current) =>
                single
                  ? [p]
                  : pair && current.length >= 2
                    ? [current[1] as PlanPoint, p]
                    : [...current, p],
              );
              setSelected(single ? 0 : null);
            }}
          />
        ) : null}
        {plan.pins.map((pin, i) => (
          <span
            key={pin.id}
            aria-hidden="true"
            className="pointer-events-none absolute flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-text-12 font-semibold text-text-on-accent"
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          >
            {i + 1}
          </span>
        ))}
        {visibleNotes.map((note) => {
          const at = parsePointAnchor(note.anchor);
          if (!at) return null;
          return (
            <Link
              key={note.threadId}
              href={(threadHrefs[note.threadId] ?? "") as Route}
              scroll={false}
              aria-label={t(note.resolved ? "plans.notes.resolvedMarker" : "plans.notes.marker", {
                count: note.count,
              })}
              className={`absolute flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-text-12 font-semibold ${note.resolved ? "border-border-strong bg-bg-raised text-text-secondary" : "border-warning bg-bg-raised text-text-primary"}`}
              style={{ left: `${at[0] * 100}%`, top: `${at[1] * 100}%` }}
            >
              {note.count}
            </Link>
          );
        })}
        {legacyDraft ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-bg-canvas"
            style={{ left: `${legacyDraft.x * 100}%`, top: `${legacyDraft.y * 100}%` }}
          />
        ) : null}
      </div>
      {toolsShown ? (
        <PlanTools
          org={org}
          plan={plan}
          zones={zones}
          units={units}
          editable={editable}
          canComment={canComment}
          tool={tool}
          setTool={(next) => {
            setTool(next);
            setPoints([]);
            setSelected(null);
          }}
          points={points}
          setPoints={setPoints}
          selected={selected}
          setSelected={setSelected}
        />
      ) : null}
      <ol aria-label={t("plans.legend")} className="m-0 flex list-none flex-col gap-8 p-0">
        {plan.pins.length === 0 && shapes.length === 0 ? (
          <li className="text-text-13 text-text-secondary">
            {canWrite && draft ? t("plans.noPins") : t("plans.noPinsReadOnly")}
          </li>
        ) : null}
        {plan.pins.map((pin) => (
          <PinRow
            key={pin.id}
            org={org}
            pin={pin}
            n={pinNumber.get(pin.id) ?? 0}
            zone={pin.zoneId ? zoneName.get(pin.zoneId) : undefined}
            canWrite={canWrite && draft}
            signs={signsAtPins[pin.id] ?? []}
            comments={openComments[pin.id] ?? 0}
            commentsHref={threadHrefs[pin.id] ?? ""}
          />
        ))}
        {shapes.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-8 border-b border-border-subtle pb-8 text-text-13"
          >
            <span>
              {t("plans.shapeLine", {
                n: shapeNumber.get(s.id) ?? 0,
                kind: t(`plans.tools.${s.kind.toLowerCase()}`),
                label: s.label,
              })}
              {s.kind === "Area" && s.areaSqFt !== null
                ? ` · ${formatArea(s.areaSqFt, units, locale)}`
                : null}
              {s.kind !== "Label" && s.lengthFt !== null
                ? ` · ${formatLength(s.lengthFt, units, locale)}`
                : null}
            </span>
            <Link
              href={(threadHrefs[s.id] ?? "") as Route}
              scroll={false}
              className="text-accent-text underline"
            >
              {t("plans.comments", { count: openComments[s.id] ?? 0 })}
            </Link>
          </li>
        ))}
      </ol>
      {notes.some((n) => n.resolved) ? (
        <Link
          href={resolvedHref as Route}
          scroll={false}
          className="self-start text-text-13 text-accent-text underline"
        >
          {t(showResolved ? "plans.notes.hideResolved" : "plans.notes.showResolved")}
        </Link>
      ) : null}
      {canWrite && draft && legacy ? (
        <section aria-labelledby="pin-add-heading" className="flex flex-col gap-8">
          <h3 id="pin-add-heading" className="m-0 text-text-14 font-semibold">
            {t("plans.addPin")}
          </h3>
          <ActionForm
            key={legacyDraft ? `${legacyDraft.x}-${legacyDraft.y}` : "new"}
            action={addPinAction}
            org={org}
            hidden={{ sitePlanId: plan.id }}
            submitLabel={t("plans.addPin")}
            successMessage={t("plans.pinPlaced")}
            onSuccess={() => {
              setLegacyDraft(null);
              return null;
            }}
          >
            {(error) => (
              <>
                <Input
                  id="pin-label"
                  name="label"
                  required
                  label={t("plans.fields.label")}
                  error={error("label")}
                />
                <div className="flex flex-wrap gap-12">
                  <Input
                    id="pin-x"
                    name="x"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    required
                    label={t("plans.fields.x")}
                    defaultValue={legacyDraft ? percent(legacyDraft.x) : ""}
                    error={error("x")}
                  />
                  <Input
                    id="pin-y"
                    name="y"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    required
                    label={t("plans.fields.y")}
                    defaultValue={legacyDraft ? percent(legacyDraft.y) : ""}
                    error={error("y")}
                  />
                </div>
                <Select
                  id="pin-zone"
                  name="zoneId"
                  label={t("plans.fields.zone")}
                  value=""
                  options={[
                    { value: "", label: t("plans.fields.noZone") },
                    ...zones.map((z) => ({ value: z.id, label: `${z.code} ${z.name}` })),
                  ]}
                />
              </>
            )}
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}

function ShapeMark({
  shape,
  n,
  width,
  height,
}: {
  shape: SitePlanShape;
  n: number;
  width: number;
  height: number;
}) {
  const color = TONE_COLOR[shape.tone];
  const px = shape.points.map(([x, y]) => `${x * width},${y * height}`).join(" ");
  const first = shape.points[0];
  if (!first) return null;
  const stroke = Math.max(width, height) / 400;
  if (shape.kind === "Label") {
    return (
      <text
        x={first[0] * width}
        y={first[1] * height}
        textAnchor="middle"
        fontSize={Math.max(width, height) / 60}
        fill={color}
        paintOrder="stroke"
        stroke="var(--color-bg-canvas)"
        strokeWidth={stroke}
      >
        {shape.label}
      </text>
    );
  }
  return (
    <g>
      {shape.kind === "Area" ? (
        <polygon points={px} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={stroke} />
      ) : (
        <polyline
          points={px}
          fill="none"
          stroke={color}
          strokeWidth={shape.kind === "Barrier" ? stroke * 1.8 : stroke}
          strokeDasharray={shape.kind === "Barrier" ? `${stroke * 4} ${stroke * 2.5}` : undefined}
        />
      )}
      <circle cx={first[0] * width} cy={first[1] * height} r={stroke * 4} fill={color} />
      <text
        x={first[0] * width}
        y={first[1] * height + stroke * 1.6}
        textAnchor="middle"
        fontSize={stroke * 4.5}
        fill="var(--color-bg-canvas)"
      >
        {n}
      </text>
    </g>
  );
}

function DraftMark({
  points,
  tool,
  width,
  height,
  selected,
}: {
  points: readonly PlanPoint[];
  tool: PlanTool;
  width: number;
  height: number;
  selected: number | null;
}) {
  const stroke = Math.max(width, height) / 400;
  const px = points.map(([x, y]) => `${x * width},${y * height}`).join(" ");
  return (
    <g>
      {tool === "area" && points.length > 2 ? (
        <polygon
          points={px}
          fill="var(--color-accent-default)"
          fillOpacity={0.12}
          stroke="var(--color-accent-default)"
          strokeWidth={stroke}
        />
      ) : points.length > 1 ? (
        <polyline
          points={px}
          fill="none"
          stroke="var(--color-accent-default)"
          strokeWidth={stroke}
          strokeDasharray={`${stroke * 2} ${stroke * 2}`}
        />
      ) : null}
      {points.map(([x, y], i) => (
        <circle
          key={i}
          cx={x * width}
          cy={y * height}
          r={stroke * (i === selected ? 5 : 3.5)}
          fill="var(--color-bg-canvas)"
          stroke="var(--color-accent-default)"
          strokeWidth={stroke}
        />
      ))}
    </g>
  );
}

function PinRow({
  org,
  pin,
  n,
  zone,
  canWrite,
  signs,
  comments,
  commentsHref,
}: {
  org: string;
  pin: SitePlanPin;
  n: number;
  zone: string | undefined;
  canWrite: boolean;
  signs: readonly string[];
  comments: number;
  commentsHref: string;
}) {
  const t = useCopy("places");
  const [moving, setMoving] = useState(false);
  const pinText = t("plans.pinLine", { n, label: pin.label, x: percent(pin.x), y: percent(pin.y) });
  const line = [
    pinText,
    zone,
    signs.length > 0 ? t("plans.signsHere", { signs: signs.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-8 border-b border-border-subtle pb-8">
      <div className="flex flex-wrap items-center justify-between gap-8 text-text-13">
        <span>{line}</span>
        <span className="flex flex-wrap items-center gap-12">
          <Link href={commentsHref as Route} scroll={false} className="text-accent-text underline">
            {t("plans.comments", { count: comments })}
          </Link>
          {canWrite ? (
            <button
              type="button"
              className="min-h-24 text-accent-text underline"
              onClick={() => setMoving((m) => !m)}
            >
              {moving ? t("kit.cancel") : t("plans.move")}
            </button>
          ) : null}
        </span>
      </div>
      {moving ? (
        <ActionForm
          action={movePinAction}
          org={org}
          hidden={{ id: pin.id }}
          submitLabel={t("plans.move")}
          className="flex flex-wrap items-end gap-12"
          onSuccess={() => {
            setMoving(false);
            return null;
          }}
        >
          {(error) => (
            <>
              <Input
                id={`move-x-${pin.id}`}
                name="x"
                type="number"
                min="0"
                max="100"
                step="0.1"
                label={t("plans.fields.x")}
                defaultValue={percent(pin.x)}
                error={error("x")}
              />
              <Input
                id={`move-y-${pin.id}`}
                name="y"
                type="number"
                min="0"
                max="100"
                step="0.1"
                label={t("plans.fields.y")}
                defaultValue={percent(pin.y)}
              />
            </>
          )}
        </ActionForm>
      ) : null}
    </li>
  );
}

/**
 * Create and edit a site plan: project (on create), title, venue drawn and level. A plan starts waiting for its drawing,
 * which is uploaded on the plan; the optional image address makes a legacy plan instead, as v1 clients create them, and
 * a legacy plan's address stays editable while it is a Draft.
 */
export function SitePlanForm({
  org,
  plan,
  projects,
  venues,
  levels,
  defaultProjectId,
}: {
  org: string;
  plan?: SitePlan;
  projects: readonly { id: string; label: string }[];
  venues: readonly { id: string; name: string }[];
  levels: readonly { id: string; venueId: string; name: string }[];
  defaultProjectId?: string;
}) {
  const t = useCopy("places");
  const [venueId, setVenueId] = useState(plan?.venueId ?? "");
  const layoutFixed = plan !== undefined && plan.planState !== "Draft";
  const legacy = plan !== undefined && isLegacyPlan(plan);
  return (
    <ActionForm
      action={saveSitePlanAction}
      org={org}
      hidden={plan ? { id: plan.id, ...(layoutFixed ? { titleOnly: "1" } : {}) } : {}}
      submitLabel={plan ? t("kit.save") : t("plans.create")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (plan ? null : { create: undefined, peek: state.id })}
    >
      {(error) => (
        <>
          {plan ? null : (
            <Select
              id="plan-project"
              name="projectId"
              label={t("plans.fields.project")}
              value={defaultProjectId ?? projects[0]?.id ?? ""}
              options={projects.map((p) => ({ value: p.id, label: p.label }))}
              error={error("projectId")}
            />
          )}
          <Input
            id="plan-title"
            name="title"
            required
            width="100%"
            label={t("plans.fields.title")}
            defaultValue={plan?.title ?? ""}
            error={error("title")}
          />
          {(plan === undefined || legacy) && !layoutFixed ? (
            <Input
              id="plan-image"
              name="imageUri"
              width="100%"
              label={t("plans.fields.image")}
              help={t("plans.fields.imageHelp")}
              defaultValue={plan?.imageUri ?? ""}
              error={error("imageUri")}
            />
          ) : null}
          {layoutFixed ? null : (
            <>
              <Select
                id="plan-venue"
                name="venueId"
                label={t("plans.fields.venue")}
                value={venueId}
                onChange={(e) => setVenueId(e.currentTarget.value)}
                options={[
                  { value: "", label: t("plans.fields.noVenue") },
                  ...venues.map((v) => ({ value: v.id, label: v.name })),
                ]}
              />
              <Select
                id="plan-level"
                name="venueLevelId"
                label={t("plans.levels.level")}
                value={plan?.venueLevelId ?? ""}
                options={[
                  { value: "", label: t("plans.levels.noLevel") },
                  ...levels
                    .filter((l) => l.venueId === venueId)
                    .map((l) => ({ value: l.id, label: l.name })),
                ]}
                error={error("venueLevelId")}
              />
            </>
          )}
        </>
      )}
    </ActionForm>
  );
}
