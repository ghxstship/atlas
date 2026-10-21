"use client";

import { Button, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { keepInputOnSubmit, useResetOnSuccess } from "@/components/collection-kit/keep-input";
import { DeferredDialog } from "@/components/lazy-ui/deferred";
import {
  addCoverageAction,
  attestMeasurementAction,
  correctFigureAction,
  recordFigureAction,
  saveObjectiveAction,
  withdrawCoverageAction,
  withdrawFigureAction,
  withdrawObjectiveAction,
  type MeasurementActionState,
} from "@/lib/measurement/actions";
import type { MeasurementT } from "./format";

/**
 * The client forms of the measurement panels (A98): set an objective at gate 1, record a figure or that it was not
 * measured, correct or withdraw one with a reason, add or withdraw coverage, and record the objectives or the
 * measurement on the evidence spine. The server actions and the database decide; refusals show in words under
 * `measurement.errors`, with what the person typed kept.
 */

type Action = (state: MeasurementActionState, form: FormData) => Promise<MeasurementActionState>;

export interface Choice {
  readonly value: string;
  readonly label: string;
}
export interface MetricChoice extends Choice {
  readonly dimension: string;
}
export interface UnitChoice extends Choice {
  readonly dimension: string;
}

interface Where {
  readonly org: string;
  readonly projectKey: string;
}

function useT(): MeasurementT {
  return useTranslations("measurement") as unknown as MeasurementT;
}

function Hidden({ org, projectKey }: Where) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectKey" value={projectKey} />
    </>
  );
}

function Feedback({ state, success }: { state: MeasurementActionState; success?: string }) {
  const t = useT();
  if (state.ok && success) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {success}
      </p>
    );
  }
  if (!state.error) return null;
  return <InlineAlert tone="danger">{t(`errors.${state.error}`, state.values ?? {})}</InlineAlert>;
}

/** The catalog message for a field's error, or the empty string. */
const fieldError = (t: MeasurementT, state: MeasurementActionState, name: string): string => {
  const key = state.fieldErrors?.[name];
  return key ? t(`errors.${key}`) : "";
};
const echoed = (state: MeasurementActionState, name: string, fallback = "") =>
  state.echo?.[name] ?? fallback;

/** useActionState for a form inside a dialog, closing it after a success. */
function useClosing(action: Action, close: () => void) {
  return useActionState(async (state: MeasurementActionState, form: FormData) => {
    const next = await action(state, form);
    if (next.ok) close();
    return next;
  }, {});
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
  const t = useT();
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
export function ObjectiveForm({
  org,
  projectKey,
  metrics,
  units,
  directions,
  objectives,
}: Where & {
  metrics: readonly MetricChoice[];
  units: readonly UnitChoice[];
  directions: readonly Choice[];
  objectives: Readonly<Record<string, ObjectiveDraft>>;
}) {
  const t = useT();
  const [state, action, pending] = useActionState(saveObjectiveAction, {});
  const [metric, setMetric] = useState(echoed(state, "metricCode", metrics[0]?.value ?? ""));
  const current = objectives[metric];
  const dimension = metrics.find((m) => m.value === metric)?.dimension ?? "";
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("objectives.formLabel")}
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <input type="hidden" name="objectiveId" value={current?.id ?? ""} />
      <Feedback state={state} success={t("objectives.saved")} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="objective-metric"
          name="metricCode"
          label={t("fields.metric")}
          value={metric}
          options={[...metrics]}
          onChange={(e) => setMetric(e.target.value)}
          error={fieldError(t, state, "metricCode")}
        />
        {/* Keyed by metric, so a metric that already has an objective fills its target to change. */}
        <div key={metric} className="contents">
          <Select
            id="objective-direction"
            name="direction"
            label={t("fields.direction")}
            value={current?.direction ?? directions[0]?.value ?? ""}
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
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {current ? t("objectives.change") : t("objectives.set")}
        </Button>
      </div>
    </form>
  );
}

export function WithdrawObjectiveButton({
  org,
  projectKey,
  objectiveId,
  metric,
}: Where & { objectiveId: string; metric: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosing(withdrawObjectiveAction, () => setOpen(false));
  const formId = `withdraw-objective-${objectiveId}`;
  return (
    <DeferredDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" aria-label={t("objectives.withdrawFor", { metric })}>
          {t("withdraw")}
        </Button>
      }
      title={t("objectives.withdrawTitle", { metric })}
      description={t("objectives.withdrawDescription")}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={pending}>
            {t("withdraw")}
          </Button>
        </>
      }
    >
      <form id={formId} action={action} onSubmit={keepInputOnSubmit(action)}>
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="objectiveId" value={objectiveId} />
        <Feedback state={state} />
      </form>
    </DeferredDialog>
  );
}

/** Records the objectives (gate 1) or the measurement (gate 8) on the evidence spine. */
export function AttestButton({
  org,
  projectKey,
  kind,
  note,
  label,
  success,
}: Where & { kind: "objectives" | "measurement"; note: string; label: string; success: string }) {
  const [state, action, pending] = useActionState(attestMeasurementAction, {});
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-wrap items-center gap-8"
    >
      <Hidden org={org} projectKey={projectKey} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="note" value={note} />
      <Button type="submit" variant="secondary" size="sm" icon="ShieldCheck" loading={pending}>
        {label}
      </Button>
      <Feedback state={state} success={success} />
    </form>
  );
}

// Figures ------------------------------------------------------------------------------------------------------------

/** Records a figure, or that it was not measured. */
export function FigureForm({
  org,
  projectKey,
  metrics,
  units,
  today,
}: Where & { metrics: readonly MetricChoice[]; units: readonly UnitChoice[]; today: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(recordFigureAction, {});
  const form = useResetOnSuccess(state);
  const [metric, setMetric] = useState(echoed(state, "metricCode", metrics[0]?.value ?? ""));
  const [unmeasured, setUnmeasured] = useState(false);
  const dimension = metrics.find((m) => m.value === metric)?.dimension ?? "";
  return (
    <form
      ref={form}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("figures.formLabel")}
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <Feedback state={state} success={t("figures.recorded")} />
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
        <Input
          id="figure-source-uri"
          name="sourceUri"
          type="url"
          maxLength={2000}
          label={t("fields.sourceUri")}
          defaultValue={echoed(state, "sourceUri")}
          error={fieldError(t, state, "sourceUri")}
        />
      </div>
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("figures.record")}
        </Button>
      </div>
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
export function CorrectFigureDialog({
  org,
  projectKey,
  figure,
  units,
  today,
}: Where & { figure: FigureDraft; units: readonly UnitChoice[]; today: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosing(correctFigureAction, () => setOpen(false));
  const [unmeasured, setUnmeasured] = useState(figure.value === null);
  const formId = `correct-${figure.id}`;
  return (
    <DeferredDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("figures.correctFor", { metric: figure.metric, date: figure.dayLabel })}
        >
          {t("figures.correct")}
        </Button>
      }
      title={t("figures.correctFor", { metric: figure.metric, date: figure.dayLabel })}
      description={t("figures.correctDescription")}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t("figures.saveCorrection")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
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
            id={`${formId}-value`}
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
            id={`${formId}-unit`}
            units={units}
            dimension={figure.dimension}
            value={echoed(state, "unitCode", figure.unitCode ?? "")}
            error={fieldError(t, state, "unitCode")}
          />
          <Input
            id={`${formId}-day`}
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
          id={`${formId}-not-measured`}
          name="notMeasured"
          label={t("figures.notMeasured")}
          checked={unmeasured}
          onChange={(e) => setUnmeasured(e.target.checked)}
        />
        <Textarea
          id={`${formId}-reason`}
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
    </DeferredDialog>
  );
}

export function WithdrawFigureDialog({
  org,
  projectKey,
  figure,
}: Where & { figure: Pick<FigureDraft, "id" | "metric" | "dayLabel"> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosing(withdrawFigureAction, () => setOpen(false));
  const formId = `withdraw-figure-${figure.id}`;
  return (
    <DeferredDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("figures.withdrawFor", { metric: figure.metric, date: figure.dayLabel })}
        >
          {t("withdraw")}
        </Button>
      }
      title={t("figures.withdrawFor", { metric: figure.metric, date: figure.dayLabel })}
      description={t("figures.withdrawDescription")}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={pending}>
            {t("withdraw")}
          </Button>
        </>
      }
    >
      <form id={formId} action={action} onSubmit={keepInputOnSubmit(action)} noValidate>
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="measurementId" value={figure.id} />
        <Feedback state={state} />
        <Textarea
          id={`${formId}-reason`}
          name="reason"
          maxLength={500}
          width="100%"
          label={t("figures.withdrawReason")}
          defaultValue={echoed(state, "reason")}
          error={fieldError(t, state, "reason")}
        />
      </form>
    </DeferredDialog>
  );
}

// Earned media -------------------------------------------------------------------------------------------------------

/** Adds a piece of coverage: sourced, dated and linked, with its reach and tone when known. */
export function CoverageForm({
  org,
  projectKey,
  mediums,
  tones,
  today,
}: Where & { mediums: readonly Choice[]; tones: readonly Choice[]; today: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(addCoverageAction, {});
  const form = useResetOnSuccess(state);
  return (
    <form
      ref={form}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("coverage.formLabel")}
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-12"
      noValidate
    >
      <Hidden org={org} projectKey={projectKey} />
      <Feedback state={state} success={t("coverage.added")} />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="coverage-title"
          name="title"
          required
          maxLength={300}
          label={t("fields.headline")}
          defaultValue={echoed(state, "title")}
          error={fieldError(t, state, "title")}
        />
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
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="coverage-url"
          name="url"
          type="url"
          maxLength={2000}
          label={t("fields.url")}
          defaultValue={echoed(state, "url")}
          error={fieldError(t, state, "url")}
        />
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
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("coverage.add")}
        </Button>
      </div>
    </form>
  );
}

export function WithdrawCoverageButton({
  org,
  projectKey,
  itemId,
  title,
}: Where & { itemId: string; title: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosing(withdrawCoverageAction, () => setOpen(false));
  const formId = `withdraw-coverage-${itemId}`;
  return (
    <DeferredDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" aria-label={t("coverage.withdrawFor", { title })}>
          {t("withdraw")}
        </Button>
      }
      title={t("coverage.withdrawFor", { title })}
      description={t("coverage.withdrawDescription")}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={pending}>
            {t("withdraw")}
          </Button>
        </>
      }
    >
      <form id={formId} action={action} onSubmit={keepInputOnSubmit(action)}>
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="itemId" value={itemId} />
        <Feedback state={state} />
      </form>
    </DeferredDialog>
  );
}
