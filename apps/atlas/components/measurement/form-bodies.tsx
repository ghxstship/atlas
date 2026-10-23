"use client";

import { Checkbox, Input, Select, Textarea } from "@xos/ui";
import { useActionState, useEffect, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  addCoverageAction,
  correctFigureAction,
  recordFigureAction,
  saveObjectiveAction,
  withdrawFigureAction,
  type MeasurementActionState,
} from "@/lib/measurement/actions";
import {
  Feedback,
  Hidden,
  useMeasurementT,
  type Choice,
  type MetricChoice,
  type UnitChoice,
  type Where,
} from "./form-kit";
import type { MeasurementT } from "./format";

/**
 * The bodies of the measurement dialogs (A98): set an objective, record a figure or that it was not measured, correct
 * or withdraw a figure with a reason, and add coverage. They load when a dialog first opens (forms.tsx), so the Gates
 * tab ships only the buttons that open them (ADR 0027). Each submits through its server action, keeps what the person
 * typed on a refusal, and tells its dialog when it is pending and when it is done.
 */

type Action = (state: MeasurementActionState, form: FormData) => Promise<MeasurementActionState>;

/** How a body talks to the dialog that holds it: its form id for the dialog's submit button, pending and done. */
export interface BodyControl {
  readonly formId: string;
  readonly onPending: (pending: boolean) => void;
  readonly onDone: () => void;
}

/** The catalog message for a field's error, or the empty string. */
const fieldError = (t: MeasurementT, state: MeasurementActionState, name: string): string => {
  const key = state.fieldErrors?.[name];
  return key ? t(`errors.${key}`) : "";
};
const echoed = (state: MeasurementActionState, name: string, fallback = "") =>
  state.echo?.[name] ?? fallback;

/** useActionState that reports pending to the dialog and closes it after a success. */
function useBodyAction(action: Action, control: BodyControl) {
  const { onPending, onDone } = control;
  const result = useActionState(async (state: MeasurementActionState, form: FormData) => {
    const next = await action(state, form);
    if (next.ok) onDone();
    return next;
  }, {});
  const pending = result[2];
  useEffect(() => onPending(pending), [pending, onPending]);
  return result;
}

function UnitSelect({
  id,
  units,
  dimension,
  value,
  error,
}: {
  id: string;
  units: readonly UnitChoice[];
  dimension: string;
  value: string;
  error: string;
}) {
  const t = useMeasurementT();
  const own = units.filter((u) => u.dimension === dimension);
  return (
    <Select
      key={dimension}
      id={id}
      name="unitCode"
      label={t("fields.unit")}
      value={own.some((u) => u.value === value) ? value : (own[0]?.value ?? "")}
      options={[...own]}
      error={error}
    />
  );
}

// Objectives ---------------------------------------------------------------------------------------------------------

export interface ObjectiveDraft {
  readonly id: string;
  readonly direction: string;
  readonly targetValue: number;
  readonly unitCode: string;
  readonly note: string | null;
}

/** Sets an objective for a metric, or changes the live one when the metric already has one. */
export function ObjectiveBody({
  org,
  projectKey,
  metrics,
  units,
  directions,
  objectives,
  ...control
}: Where &
  BodyControl & {
    metrics: readonly MetricChoice[];
    units: readonly UnitChoice[];
    directions: readonly Choice[];
    objectives: Readonly<Record<string, ObjectiveDraft>>;
  }) {
  const t = useMeasurementT();
  const [state, action] = useBodyAction(saveObjectiveAction, control);
  const [metric, setMetric] = useState(echoed(state, "metricCode", metrics[0]?.value ?? ""));
  const current = objectives[metric];
  const dimension = metrics.find((m) => m.value === metric)?.dimension ?? "";
  return (
    <form
      id={control.formId}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <input type="hidden" name="objectiveId" value={current?.id ?? ""} />
      <Feedback state={state} />
      <Select
        id="objective-metric"
        name="metricCode"
        label={t("fields.metric")}
        {...(current ? { help: t("objectives.changeHelp") } : {})}
        value={metric}
        options={[...metrics]}
        onChange={(e) => setMetric(e.target.value)}
        error={fieldError(t, state, "metricCode")}
      />
      {/* Keyed by metric, so a metric that already has an objective fills its target to change. */}
      <div key={metric} className="flex flex-wrap items-end gap-12">
        <Select
          id="objective-direction"
          name="direction"
          label={t("fields.direction")}
          value={current?.direction ?? echoed(state, "direction", directions[0]?.value ?? "")}
          options={[...directions]}
          error={fieldError(t, state, "direction")}
        />
        <Input
          id="objective-target"
          name="targetValue"
          type="number"
          step="any"
          min={0}
          required
          width={160}
          label={t("fields.target")}
          defaultValue={current ? String(current.targetValue) : echoed(state, "targetValue")}
          error={fieldError(t, state, "targetValue")}
        />
        <UnitSelect
          id="objective-unit"
          units={units}
          dimension={dimension}
          value={current?.unitCode ?? echoed(state, "unitCode")}
          error={fieldError(t, state, "unitCode")}
        />
      </div>
      <Textarea
        key={`note-${metric}`}
        id="objective-note"
        name="note"
        maxLength={2000}
        width="100%"
        label={t("fields.note")}
        defaultValue={current?.note ?? echoed(state, "note")}
        error={fieldError(t, state, "note")}
      />
    </form>
  );
}

// Figures ------------------------------------------------------------------------------------------------------------

/** Records a figure, or that it was not measured. */
export function FigureBody({
  org,
  projectKey,
  metrics,
  units,
  today,
  ...control
}: Where &
  BodyControl & { metrics: readonly MetricChoice[]; units: readonly UnitChoice[]; today: string }) {
  const t = useMeasurementT();
  const [state, action] = useBodyAction(recordFigureAction, control);
  const [metric, setMetric] = useState(echoed(state, "metricCode", metrics[0]?.value ?? ""));
  const [unmeasured, setUnmeasured] = useState(false);
  const dimension = metrics.find((m) => m.value === metric)?.dimension ?? "";
  return (
    <form
      id={control.formId}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <Feedback state={state} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="figure-metric"
          name="metricCode"
          label={t("fields.metric")}
          value={metric}
          options={[...metrics]}
          onChange={(e) => setMetric(e.target.value)}
          error={fieldError(t, state, "metricCode")}
        />
        <Input
          id="figure-day"
          name="measuredOn"
          type="date"
          max={today}
          required
          width={180}
          label={t("fields.measuredOn")}
          defaultValue={echoed(state, "measuredOn", today)}
          error={fieldError(t, state, "measuredOn")}
        />
      </div>
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="figure-value"
          name="value"
          type="number"
          step="any"
          min={0}
          width={160}
          disabled={unmeasured}
          label={t("fields.value")}
          defaultValue={echoed(state, "value")}
          error={fieldError(t, state, "value")}
        />
        <UnitSelect
          id="figure-unit"
          units={units}
          dimension={dimension}
          value={echoed(state, "unitCode")}
          error={fieldError(t, state, "unitCode")}
        />
      </div>
      <Checkbox
        id="figure-not-measured"
        name="notMeasured"
        label={t("figures.notMeasured")}
        checked={unmeasured}
        onChange={(e) => setUnmeasured(e.target.checked)}
        aria-describedby="figure-not-measured-help"
      />
      <p id="figure-not-measured-help" className="m-0 text-text-12 text-text-secondary">
        {t("figures.notMeasuredHelp")}
      </p>
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="figure-source"
          name="source"
          label={t("fields.source")}
          value={echoed(state, "source", "Manual")}
          options={[
            { value: "Manual", label: t("sources.manual") },
            { value: "Import", label: t("sources.import") },
          ]}
        />
        <Input
          id="figure-source-reference"
          name="sourceReference"
          maxLength={300}
          label={t("fields.sourceReference")}
          help={t("fields.sourceReferenceHelp")}
          defaultValue={echoed(state, "sourceReference")}
          error={fieldError(t, state, "sourceReference")}
        />
      </div>
      <Input
        id="figure-source-uri"
        name="sourceUri"
        type="url"
        maxLength={2000}
        width="100%"
        label={t("fields.sourceUri")}
        defaultValue={echoed(state, "sourceUri")}
        error={fieldError(t, state, "sourceUri")}
      />
    </form>
  );
}

export interface FigureDraft {
  readonly id: string;
  readonly metric: string;
  readonly dimension: string;
  readonly measuredOn: string;
  readonly value: number | null;
  readonly unitCode: string | null;
  readonly dayLabel: string;
}

/** Corrects a figure's value, unit or day with a reason, which the correction log keeps. */
export function CorrectBody({
  org,
  projectKey,
  figure,
  units,
  today,
  ...control
}: Where & BodyControl & { figure: FigureDraft; units: readonly UnitChoice[]; today: string }) {
  const t = useMeasurementT();
  const [state, action] = useBodyAction(correctFigureAction, control);
  const [unmeasured, setUnmeasured] = useState(figure.value === null);
  const id = control.formId;
  return (
    <form
      id={id}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <input type="hidden" name="measurementId" value={figure.id} />
      <Feedback state={state} />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id={`${id}-value`}
          name="value"
          type="number"
          step="any"
          min={0}
          width={160}
          disabled={unmeasured}
          label={t("fields.value")}
          defaultValue={echoed(state, "value", figure.value === null ? "" : String(figure.value))}
          error={fieldError(t, state, "value")}
        />
        <UnitSelect
          id={`${id}-unit`}
          units={units}
          dimension={figure.dimension}
          value={echoed(state, "unitCode", figure.unitCode ?? "")}
          error={fieldError(t, state, "unitCode")}
        />
        <Input
          id={`${id}-day`}
          name="measuredOn"
          type="date"
          max={today}
          width={180}
          label={t("fields.measuredOn")}
          defaultValue={echoed(state, "measuredOn", figure.measuredOn)}
          error={fieldError(t, state, "measuredOn")}
        />
      </div>
      <Checkbox
        id={`${id}-not-measured`}
        name="notMeasured"
        label={t("figures.notMeasured")}
        checked={unmeasured}
        onChange={(e) => setUnmeasured(e.target.checked)}
      />
      <Textarea
        id={`${id}-reason`}
        name="reason"
        required
        maxLength={500}
        width="100%"
        label={t("fields.reason")}
        help={t("figures.reasonHelp")}
        defaultValue={echoed(state, "reason")}
        error={fieldError(t, state, "reason")}
      />
    </form>
  );
}

/** Withdraws a figure with an optional reason, which the correction log keeps. */
export function WithdrawFigureBody({
  org,
  projectKey,
  figureId,
  ...control
}: Where & BodyControl & { figureId: string }) {
  const t = useMeasurementT();
  const [state, action] = useBodyAction(withdrawFigureAction, control);
  return (
    <form id={control.formId} action={action} onSubmit={keepInputOnSubmit(action)} noValidate>
      <Hidden org={org} projectKey={projectKey} />
      <input type="hidden" name="measurementId" value={figureId} />
      <Feedback state={state} />
      <Textarea
        id={`${control.formId}-reason`}
        name="reason"
        maxLength={500}
        width="100%"
        label={t("figures.withdrawReason")}
        defaultValue={echoed(state, "reason")}
        error={fieldError(t, state, "reason")}
      />
    </form>
  );
}

// Earned media -------------------------------------------------------------------------------------------------------

/** Adds a piece of coverage: sourced, dated and linked, with its reach and tone when known. */
export function CoverageBody({
  org,
  projectKey,
  mediums,
  tones,
  today,
  ...control
}: Where & BodyControl & { mediums: readonly Choice[]; tones: readonly Choice[]; today: string }) {
  const t = useMeasurementT();
  const [state, action] = useBodyAction(addCoverageAction, control);
  return (
    <form
      id={control.formId}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <Feedback state={state} />
      <Input
        id="coverage-title"
        name="title"
        required
        maxLength={300}
        width="100%"
        label={t("fields.headline")}
        defaultValue={echoed(state, "title")}
        error={fieldError(t, state, "title")}
      />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="coverage-outlet"
          name="outlet"
          required
          maxLength={200}
          label={t("fields.outlet")}
          defaultValue={echoed(state, "outlet")}
          error={fieldError(t, state, "outlet")}
        />
        <Select
          id="coverage-medium"
          name="medium"
          label={t("fields.medium")}
          value={echoed(state, "medium", mediums[0]?.value ?? "")}
          options={[...mediums]}
          error={fieldError(t, state, "medium")}
        />
        <Input
          id="coverage-day"
          name="publishedOn"
          type="date"
          max={today}
          required
          width={180}
          label={t("fields.publishedOn")}
          defaultValue={echoed(state, "publishedOn", today)}
          error={fieldError(t, state, "publishedOn")}
        />
      </div>
      <Input
        id="coverage-url"
        name="url"
        type="url"
        maxLength={2000}
        width="100%"
        label={t("fields.url")}
        defaultValue={echoed(state, "url")}
        error={fieldError(t, state, "url")}
      />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="coverage-reach"
          name="reach"
          type="number"
          step={1}
          min={0}
          width={160}
          label={t("fields.reach")}
          help={t("fields.reachHelp")}
          defaultValue={echoed(state, "reach")}
          error={fieldError(t, state, "reach")}
        />
        <Select
          id="coverage-tone"
          name="tone"
          label={t("fields.tone")}
          value={echoed(state, "tone", "")}
          options={[{ value: "", label: t("unrated") }, ...tones]}
        />
      </div>
    </form>
  );
}
