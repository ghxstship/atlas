"use client";

import { InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import type { MeasurementActionState } from "@/lib/measurement/actions";
import type { MeasurementT } from "./format";

/** Shared pieces of the measurement forms (A98): choices, hidden route fields and feedback in words. */

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

export interface Where {
  readonly org: string;
  readonly projectKey: string;
}

export function useMeasurementT(): MeasurementT {
  return useTranslations("measurement") as unknown as MeasurementT;
}

export function Hidden({ org, projectKey }: Where) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectKey" value={projectKey} />
    </>
  );
}

/** A refusal or failure under `measurement.errors`, or the success sentence when given. */
export function Feedback({ state, success }: { state: MeasurementActionState; success?: string }) {
  const t = useMeasurementT();
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
