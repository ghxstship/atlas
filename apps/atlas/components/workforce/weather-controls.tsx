"use client";

import { Button, Dialog, InlineAlert, Select, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ActionFeedback } from "@/components/collection-kit/kit";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { useCopy } from "@/components/collection-kit/use-copy";
import {
  callWeatherHoldAction,
  giveWeatherAllClearAction,
  turnOffWeatherFeedAction,
  turnOnWeatherFeedAction,
} from "@/lib/workforce/actions";
import type { ActionState } from "@/lib/operations/state";
import { REFUSALS } from "./refusals";

const INITIAL: ActionState = {};

/** Runs `then` once for each new successful state of an action. */
function useOnSuccess(state: ActionState, then: () => void) {
  const seen = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && seen.current !== state) {
      seen.current = state;
      then();
    }
  });
}

/** A warning the hold can name. */
export interface HoldWarning {
  readonly id: string;
  readonly event: string;
}

/**
 * Call hold and Give all-clear (B8, 2977) in one component that stays mounted, so the result of either still shows above
 * the banner after the refresh swaps the button. The hold's message starts from the project's template, else from the
 * catalog's default in the viewer's language for the hazard and warning chosen; it starts again when they change. A
 * severe warning or a reading at Restrict or Evacuate chooses them first.
 */
export function WeatherHoldControls({
  org,
  projectId,
  openHoldId,
  hazards,
  warnings,
  prompt,
  holdTemplate,
  allClearText,
  children,
}: {
  org: string;
  projectId: string;
  openHoldId: string | null;
  /** The hazards in order, each with the viewer's word for it. */
  hazards: readonly { readonly value: string; readonly label: string }[];
  warnings: readonly HoldWarning[];
  prompt: {
    readonly hazard: string | null;
    readonly alertId: string | null;
    readonly warningId: string | null;
  };
  /** The project's own hold text, which wins over the catalog's. */
  holdTemplate: string | null;
  allClearText: string;
  /** The open hold's banner, under the result. */
  children?: ReactNode;
}) {
  const t = useCopy("workforce.weather");
  const router = useRouter();
  const formId = useId();
  const [holdState, runHold, holdPending] = useActionState(callWeatherHoldAction, INITIAL);
  const [clearState, runClear, clearPending] = useActionState(giveWeatherAllClearAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [hazard, setHazard] = useState(prompt.hazard ?? "");
  const [warningId, setWarningId] = useState(prompt.warningId ?? "");

  useOnSuccess(holdState, () => {
    setResult(t("holds.holdSent"));
    setOpen(false);
    router.refresh();
  });
  useOnSuccess(clearState, () => {
    setResult(t("holds.allClearSent"));
    setOpen(false);
    router.refresh();
  });

  const warning = warnings.find((w) => w.id === warningId);
  const hazardLabel = hazards.find((h) => h.value === hazard)?.label;
  const holdText =
    holdTemplate ??
    (warning
      ? t("templates.defaultHoldWarning", { event: warning.event })
      : hazardLabel
        ? t("templates.defaultHoldHazard", { hazard: hazardLabel })
        : t("templates.defaultHold"));
  const label = openHoldId ? t("holds.allClear") : t("holds.call");
  const pending = openHoldId ? clearPending : holdPending;
  const state = openHoldId ? clearState : holdState;
  const run = openHoldId ? runClear : runHold;
  return (
    <>
      <div role="status">{result ? <InlineAlert tone="success">{result}</InlineAlert> : null}</div>
      {children}
      <div className="flex flex-wrap gap-8">
        <Button type="button" variant="primary" size="sm" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
      {open ? (
        <Dialog
          title={openHoldId ? t("holds.allClearTitle") : t("holds.callTitle")}
          description={t("holds.callBody")}
          open
          onOpenChange={setOpen}
          actions={
            <>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                {t("holds.cancel")}
              </Button>
              <Button type="submit" form={formId} variant="primary" loading={pending}>
                {label}
              </Button>
            </>
          }
        >
          <form
            id={formId}
            action={run}
            onSubmit={keepInputOnSubmit(run)}
            className="flex flex-col gap-12"
            noValidate
          >
            <input type="hidden" name="org" value={org} />
            {openHoldId ? (
              <>
                <input type="hidden" name="id" value={openHoldId} />
                <Textarea
                  id={`${formId}-message`}
                  name="message"
                  label={t("holds.message")}
                  help={t("holds.messageHelp")}
                  required
                  maxLength={1000}
                  width="100%"
                  defaultValue={allClearText}
                />
              </>
            ) : (
              <>
                <input type="hidden" name="projectId" value={projectId} />
                {prompt.alertId && hazard === prompt.hazard ? (
                  <input type="hidden" name="weatherAlertId" value={prompt.alertId} />
                ) : null}
                <Select
                  id={`${formId}-hazard`}
                  name="hazard"
                  label={t("holds.hazard")}
                  value={hazard}
                  onChange={(event) => setHazard(event.target.value)}
                  options={[{ value: "", label: t("holds.noHazard") }, ...hazards]}
                />
                {warnings.length > 0 ? (
                  <Select
                    id={`${formId}-warning`}
                    name="weatherWarningId"
                    label={t("holds.warning")}
                    value={warningId}
                    onChange={(event) => setWarningId(event.target.value)}
                    options={[
                      { value: "", label: t("holds.noWarning") },
                      ...warnings.map((w) => ({ value: w.id, label: w.event })),
                    ]}
                  />
                ) : null}
                {/* The default depends on the two fields above, and an uncontrolled field keeps its first default. */}
                <Textarea
                  key={`${hazard}:${warningId}`}
                  id={`${formId}-message`}
                  name="message"
                  label={t("holds.message")}
                  help={t("holds.messageHelp")}
                  required
                  maxLength={1000}
                  width="100%"
                  defaultValue={holdText}
                />
              </>
            )}
            <ActionFeedback state={state} refusals={REFUSALS} />
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The official feed's switch (B8, 2976): one component for both directions, so what happened still shows after the
 * refresh swaps the button.
 */
export function WeatherFeedSwitch({
  org,
  projectId,
  feedId,
}: {
  org: string;
  projectId: string;
  feedId: string | null;
}) {
  const t = useCopy("workforce.weather");
  const router = useRouter();
  const [onState, runOn, onPending] = useActionState(turnOnWeatherFeedAction, INITIAL);
  const [offState, runOff, offPending] = useActionState(turnOffWeatherFeedAction, INITIAL);
  const [result, setResult] = useState<string | null>(null);
  useOnSuccess(onState, () => {
    setResult(t("feed.turnedOn"));
    router.refresh();
  });
  useOnSuccess(offState, () => {
    setResult(t("feed.turnedOff"));
    router.refresh();
  });
  return (
    <div className="flex flex-col gap-8">
      <div role="status">{result ? <InlineAlert tone="success">{result}</InlineAlert> : null}</div>
      <form action={feedId ? runOff : runOn}>
        <input type="hidden" name="org" value={org} />
        {feedId ? (
          <input type="hidden" name="id" value={feedId} />
        ) : (
          <input type="hidden" name="projectId" value={projectId} />
        )}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={feedId ? offPending : onPending}
        >
          {feedId ? t("feed.turnOff") : t("feed.turnOn")}
        </Button>
      </form>
      <ActionFeedback state={feedId ? offState : onState} refusals={REFUSALS} />
    </div>
  );
}
