"use client";

import {
  DEFAULT_SHAPE_TONE,
  SHAPE_TONES,
  type SitePlan,
  type SitePlanShapeKind,
  type Zone,
} from "@xos/data/places";
import { polygonSqFt, polylineFeet, type PlanPoint } from "@xos/data/places-geometry";
import { Button, Input, Select, Textarea } from "@xos/ui";
import { useLocale } from "next-intl";
import { addPinAction } from "@/app/[org]/places/actions";
import {
  postPointNoteAction,
  saveShapeAction,
  setCalibrationAction,
} from "@/app/[org]/places/plan-actions";
import { ActionForm, useCopy } from "../kit/form";
import { formatArea, formatLength, type PlanUnits } from "./plan-units";

/** The drawing tools of a site plan (ADR 0140 D4): one active at a time. */
export type PlanTool =
  "select" | "pin" | "route" | "barrier" | "area" | "label" | "measure" | "scale" | "annotate";

const LAYOUT_TOOLS: readonly PlanTool[] = [
  "pin",
  "route",
  "barrier",
  "area",
  "label",
  "measure",
  "scale",
];
const SHAPE_OF: Partial<Record<PlanTool, SitePlanShapeKind>> = {
  route: "Route",
  barrier: "Barrier",
  area: "Area",
  label: "Label",
};

const asPercent = (v: number) => Math.round(v * 1000) / 10;

/**
 * The toolbar and the point list of a site plan, loaded on demand (next/dynamic). Every tool has a pointer path (click
 * the drawing) and a keyboard and single-pointer path (WCAG 2.5.7): the point list takes Across and Down percentages,
 * and arrow keys on the drawing nudge the selected point. Layout tools show only on a Draft plan with a stored
 * drawing; Annotate shows in every state to anyone who may comment.
 */
export function PlanTools({
  org,
  plan,
  zones,
  units,
  editable,
  canComment,
  tool,
  setTool,
  points,
  setPoints,
  selected,
  setSelected,
}: {
  org: string;
  plan: SitePlan;
  zones: readonly Zone[];
  units: PlanUnits;
  editable: boolean;
  canComment: boolean;
  tool: PlanTool;
  setTool: (tool: PlanTool) => void;
  points: readonly PlanPoint[];
  setPoints: (update: PlanPoint[] | ((current: PlanPoint[]) => PlanPoint[])) => void;
  selected: number | null;
  setSelected: (index: number | null) => void;
}) {
  const t = useCopy("places");
  const locale = useLocale();
  const tools: PlanTool[] = [
    "select",
    ...(editable ? LAYOUT_TOOLS : []),
    ...(canComment ? (["annotate"] as const) : []),
  ];
  const size = plan.drawing
    ? { widthPx: plan.drawing.widthPx, heightPx: plan.drawing.heightPx }
    : null;
  const calibration = plan.calibration;
  const closed = tool === "area";
  const length =
    size && calibration && points.length > 1
      ? polylineFeet(points, size, calibration, closed)
      : null;
  const area =
    size && calibration && closed && points.length > 2
      ? polygonSqFt(points, size, calibration)
      : null;
  const pointsJson = JSON.stringify(points.map(([x, y]) => [x, y]));
  const reset = () => {
    setPoints([]);
    setSelected(null);
  };
  const shapeKind = SHAPE_OF[tool];

  return (
    <section
      aria-labelledby="plan-tools-heading"
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-12"
    >
      <h3 id="plan-tools-heading" className="m-0 text-text-14 font-semibold">
        {t("plans.tools.title")}
      </h3>
      <div role="radiogroup" aria-label={t("plans.tools.title")} className="flex flex-wrap gap-8">
        {tools.map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={tool === name}
            onClick={() => setTool(name)}
            className={`min-h-24 rounded-control border px-8 text-text-13 ${tool === name ? "border-accent bg-accent text-text-on-accent" : "border-border-control bg-bg-raised text-text-primary"}`}
          >
            {t(`plans.tools.${name}`)}
          </button>
        ))}
      </div>
      {tool === "select" ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("plans.tools.selectHelp")}</p>
      ) : null}
      {tool !== "select" ? (
        <PointList
          points={points}
          setPoints={setPoints}
          selected={selected}
          setSelected={setSelected}
          single={tool === "pin" || tool === "label" || tool === "annotate"}
          pair={tool === "scale"}
        />
      ) : null}

      {tool === "measure" ? (
        <div className="flex flex-col gap-8">
          {calibration ? (
            <p role="status" aria-live="polite" className="m-0 text-text-14">
              {area !== null
                ? t("plans.tools.measureArea", {
                    area: formatArea(area, units, locale),
                    length: formatLength(length ?? 0, units, locale),
                  })
                : length !== null
                  ? t("plans.tools.measureLength", { length: formatLength(length, units, locale) })
                  : t("plans.tools.measureStart")}
            </p>
          ) : (
            <p role="status" className="m-0 text-text-13 text-text-secondary">
              {t("plans.tools.uncalibrated")}
            </p>
          )}
          {editable && points.length > 1 ? (
            <Button variant="secondary" size="sm" onClick={() => setTool("route")}>
              {t("plans.tools.saveAsRoute")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {tool === "scale" ? (
        <ActionForm
          action={setCalibrationAction}
          org={org}
          hidden={{ sitePlanId: plan.id, points: pointsJson }}
          submitLabel={t("plans.tools.saveScale")}
          successMessage={t("plans.tools.scaleSaved")}
          onSuccess={() => {
            reset();
            return null;
          }}
        >
          {(error) => (
            <>
              <p className="m-0 text-text-13 text-text-secondary">
                {t("plans.tools.uncalibrated")}
              </p>
              <div className="flex flex-wrap items-end gap-12">
                <Input
                  id="scale-distance"
                  name="distance"
                  type="number"
                  min="0"
                  step="any"
                  required
                  label={t("plans.tools.distance")}
                  error={error("distance") ?? error("points")}
                />
                <Select
                  id="scale-unit"
                  name="unit"
                  label={t("plans.tools.unit")}
                  value={units === "metric" ? "m" : "ft"}
                  options={[
                    { value: "ft", label: t("plans.tools.feet") },
                    { value: "m", label: t("plans.tools.meters") },
                  ]}
                />
              </div>
            </>
          )}
        </ActionForm>
      ) : null}

      {tool === "pin" ? (
        <ActionForm
          action={addPinAction}
          org={org}
          hidden={{
            sitePlanId: plan.id,
            x: points[0] ? String(asPercent(points[0][0])) : "",
            y: points[0] ? String(asPercent(points[0][1])) : "",
          }}
          submitLabel={t("plans.addPin")}
          successMessage={t("plans.pinPlaced")}
          onSuccess={() => {
            reset();
            return null;
          }}
        >
          {(error) => (
            <>
              <Input
                id="tool-pin-label"
                name="label"
                required
                label={t("plans.fields.label")}
                error={error("label") ?? error("x")}
              />
              <Select
                id="tool-pin-zone"
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
      ) : null}

      {shapeKind ? (
        <ActionForm
          key={shapeKind}
          action={saveShapeAction}
          org={org}
          hidden={{ sitePlanId: plan.id, kind: shapeKind, points: pointsJson }}
          submitLabel={t("plans.tools.saveShape")}
          successMessage={t("plans.tools.shapeSaved")}
          onSuccess={() => {
            reset();
            return null;
          }}
        >
          {(error) => (
            <>
              {calibration && length !== null && shapeKind !== "Label" ? (
                <p role="status" aria-live="polite" className="m-0 text-text-13">
                  {area !== null
                    ? t("plans.tools.measureArea", {
                        area: formatArea(area, units, locale),
                        length: formatLength(length, units, locale),
                      })
                    : t("plans.tools.measureLength", {
                        length: formatLength(length, units, locale),
                      })}
                </p>
              ) : null}
              <Input
                id={`shape-label-${shapeKind}`}
                name="label"
                required
                label={t("plans.fields.label")}
                defaultValue={t(`plans.tools.${tool}`)}
                error={error("label") ?? error("points")}
              />
              <Select
                id={`shape-tone-${shapeKind}`}
                name="tone"
                label={t("plans.tools.tone")}
                value={DEFAULT_SHAPE_TONE[shapeKind]}
                options={SHAPE_TONES.map((tone) => ({
                  value: tone,
                  label: t(`plans.tones.${tone}`),
                }))}
              />
            </>
          )}
        </ActionForm>
      ) : null}

      {tool === "annotate" ? (
        <ActionForm
          action={postPointNoteAction}
          org={org}
          hidden={{ sitePlanId: plan.id, points: pointsJson }}
          submitLabel={t("plans.notes.post")}
          successMessage={t("plans.notes.posted")}
          onSuccess={() => {
            reset();
            return null;
          }}
        >
          {(error) => (
            <Textarea
              id="note-body"
              name="body"
              required
              label={t("plans.notes.body")}
              help={t("plans.notes.help")}
              error={error("body") ?? error("points")}
            />
          )}
        </ActionForm>
      ) : null}
    </section>
  );
}

/** The keyboard path of every tool: each point as Across and Down percentages, with add, remove and select. */
function PointList({
  points,
  setPoints,
  selected,
  setSelected,
  single,
  pair,
}: {
  points: readonly PlanPoint[];
  setPoints: (update: PlanPoint[] | ((current: PlanPoint[]) => PlanPoint[])) => void;
  selected: number | null;
  setSelected: (index: number | null) => void;
  single: boolean;
  pair: boolean;
}) {
  const t = useCopy("places");
  const set = (i: number, axis: 0 | 1, raw: string) => {
    const value = Number(raw) / 100;
    if (!Number.isFinite(value) || value < 0 || value > 1) return;
    setPoints((current) =>
      current.map((p, j) => (j === i ? (axis === 0 ? [value, p[1]] : [p[0], value]) : p)),
    );
  };
  const max = single ? 1 : pair ? 2 : 500;
  return (
    <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
      <legend className="text-text-13 font-semibold">{t("plans.tools.points")}</legend>
      <p className="m-0 text-text-12 text-text-secondary">{t("plans.tools.nudgeHelp")}</p>
      <ol className="m-0 flex list-none flex-col gap-8 p-0">
        {points.map((p, i) => (
          // Keyed by the point, so a click or a nudge refreshes the fields; a typed value is taken when the field is left.
          <li key={`${i}-${p[0]}-${p[1]}`} className="flex flex-wrap items-end gap-8">
            <Input
              id={`point-x-${i}`}
              type="number"
              min="0"
              max="100"
              step="0.1"
              label={t("plans.tools.across", { n: i + 1 })}
              defaultValue={asPercent(p[0])}
              onBlur={(e) => set(i, 0, e.currentTarget.value)}
            />
            <Input
              id={`point-y-${i}`}
              type="number"
              min="0"
              max="100"
              step="0.1"
              label={t("plans.tools.down", { n: i + 1 })}
              defaultValue={asPercent(p[1])}
              onBlur={(e) => set(i, 1, e.currentTarget.value)}
            />
            <Button
              variant={selected === i ? "primary" : "secondary"}
              size="sm"
              onClick={() => setSelected(i)}
            >
              {t("plans.tools.selectPoint")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPoints((current) => current.filter((_, j) => j !== i));
                setSelected(null);
              }}
            >
              {t("plans.tools.removePoint")}
            </Button>
          </li>
        ))}
      </ol>
      {points.length < max ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setPoints((current) => [...current, [0.5, 0.5]]);
            setSelected(points.length);
          }}
        >
          {t("plans.tools.addPoint")}
        </Button>
      ) : null}
    </fieldset>
  );
}
