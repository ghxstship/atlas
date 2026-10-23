"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useActionState, useCallback, useState, type ReactElement, type ReactNode } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { DeferredDialog } from "@/components/lazy-ui/deferred";
import {
  attestMeasurementAction,
  withdrawCoverageAction,
  withdrawObjectiveAction,
  type MeasurementActionState,
} from "@/lib/measurement/actions";
import type { FigureDraft, ObjectiveDraft } from "./form-bodies";
import {
  Feedback,
  Hidden,
  useMeasurementT,
  type Choice,
  type MetricChoice,
  type UnitChoice,
  type Where,
} from "./form-kit";

export type { Choice, MetricChoice, UnitChoice } from "./form-kit";
export type { FigureDraft, ObjectiveDraft } from "./form-bodies";

/**
 * The controls of the measurement panels (A98): buttons that open the dialogs to set an objective, record, correct or
 * withdraw a figure and add coverage, plus withdrawing an objective or a piece of coverage and recording the objectives
 * or the measurement on the evidence spine. The dialog bodies load when a dialog first opens (ADR 0027: overlays
 * that open on an action load on demand), so the Gates tab ships only these buttons. The server actions and the
 * database decide; refusals show in words under `measurement.errors`.
 */

const ObjectiveBody = dynamic(() => import("./form-bodies").then((m) => m.ObjectiveBody));
const FigureBody = dynamic(() => import("./form-bodies").then((m) => m.FigureBody));
const CorrectBody = dynamic(() => import("./form-bodies").then((m) => m.CorrectBody));
const WithdrawFigureBody = dynamic(() => import("./form-bodies").then((m) => m.WithdrawFigureBody));
const CoverageBody = dynamic(() => import("./form-bodies").then((m) => m.CoverageBody));

interface Control {
  readonly formId: string;
  readonly onPending: (pending: boolean) => void;
  readonly onDone: () => void;
}

/**
 * A dialog whose trigger renders with the page and whose body loads on first open. The body submits the form named
 * `formId` with the dialog's primary button, reports pending, and closes the dialog when it is done.
 */
function FormDialog({
  formId,
  trigger,
  title,
  description,
  submit,
  danger = false,
  children,
}: {
  formId: string;
  trigger: ReactElement;
  title: string;
  description?: string;
  submit: string;
  danger?: boolean;
  children: (control: Control) => ReactNode;
}) {
  const t = useMeasurementT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const onDone = useCallback(() => setOpen(false), []);
  return (
    <DeferredDialog
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={title}
      {...(description ? { description } : {})}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={danger ? "danger" : "primary"}
            loading={pending}
          >
            {submit}
          </Button>
        </>
      }
    >
      {children({ formId, onPending: setPending, onDone })}
    </DeferredDialog>
  );
}

// Objectives ---------------------------------------------------------------------------------------------------------

/** Opens the dialog that sets an objective, or changes the live one of the chosen metric. */
export function ObjectiveDialog(
  props: Where & {
    metrics: readonly MetricChoice[];
    units: readonly UnitChoice[];
    directions: readonly Choice[];
    objectives: Readonly<Record<string, ObjectiveDraft>>;
  },
) {
  const t = useMeasurementT();
  return (
    <FormDialog
      formId="objective-form"
      trigger={
        <Button variant="secondary" size="sm" icon="Plus">
          {t("objectives.set")}
        </Button>
      }
      title={t("objectives.formLabel")}
      description={t("objectives.formDescription")}
      submit={t("objectives.save")}
    >
      {(control) => <ObjectiveBody {...props} {...control} />}
    </FormDialog>
  );
}

export function WithdrawObjectiveButton({
  org,
  projectKey,
  objectiveId,
  metric,
}: Where & { objectiveId: string; metric: string }) {
  const t = useMeasurementT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(
    async (s: MeasurementActionState, form: FormData) => {
      const next = await withdrawObjectiveAction(s, form);
      if (next.ok) setOpen(false);
      return next;
    },
    {},
  );
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

/** Opens the dialog that records a figure, or that it was not measured. */
export function FigureDialog(
  props: Where & { metrics: readonly MetricChoice[]; units: readonly UnitChoice[]; today: string },
) {
  const t = useMeasurementT();
  return (
    <FormDialog
      formId="figure-form"
      trigger={
        <Button variant="secondary" size="sm" icon="Plus">
          {t("figures.record")}
        </Button>
      }
      title={t("figures.formLabel")}
      description={t("figures.formDescription")}
      submit={t("figures.record")}
    >
      {(control) => <FigureBody {...props} {...control} />}
    </FormDialog>
  );
}

export function CorrectFigureDialog({
  figure,
  ...rest
}: Where & { figure: FigureDraft; units: readonly UnitChoice[]; today: string }) {
  const t = useMeasurementT();
  const title = t("figures.correctFor", { metric: figure.metric, date: figure.dayLabel });
  return (
    <FormDialog
      formId={`correct-${figure.id}`}
      trigger={
        <Button size="sm" variant="ghost" aria-label={title}>
          {t("figures.correct")}
        </Button>
      }
      title={title}
      description={t("figures.correctDescription")}
      submit={t("figures.saveCorrection")}
    >
      {(control) => <CorrectBody {...rest} figure={figure} {...control} />}
    </FormDialog>
  );
}

export function WithdrawFigureDialog({
  figure,
  ...where
}: Where & { figure: Pick<FigureDraft, "id" | "metric" | "dayLabel"> }) {
  const t = useMeasurementT();
  const title = t("figures.withdrawFor", { metric: figure.metric, date: figure.dayLabel });
  return (
    <FormDialog
      formId={`withdraw-figure-${figure.id}`}
      trigger={
        <Button size="sm" variant="ghost" aria-label={title}>
          {t("withdraw")}
        </Button>
      }
      title={title}
      description={t("figures.withdrawDescription")}
      submit={t("withdraw")}
      danger
    >
      {(control) => <WithdrawFigureBody {...where} figureId={figure.id} {...control} />}
    </FormDialog>
  );
}

// Earned media -------------------------------------------------------------------------------------------------------

/** Opens the dialog that adds a piece of coverage. */
export function CoverageDialog(
  props: Where & { mediums: readonly Choice[]; tones: readonly Choice[]; today: string },
) {
  const t = useMeasurementT();
  return (
    <FormDialog
      formId="coverage-form"
      trigger={
        <Button variant="secondary" size="sm" icon="Plus">
          {t("coverage.add")}
        </Button>
      }
      title={t("coverage.formLabel")}
      description={t("coverage.description")}
      submit={t("coverage.add")}
    >
      {(control) => <CoverageBody {...props} {...control} />}
    </FormDialog>
  );
}

export function WithdrawCoverageButton({
  org,
  projectKey,
  itemId,
  title,
}: Where & { itemId: string; title: string }) {
  const t = useMeasurementT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(
    async (s: MeasurementActionState, form: FormData) => {
      const next = await withdrawCoverageAction(s, form);
      if (next.ok) setOpen(false);
      return next;
    },
    {},
  );
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
