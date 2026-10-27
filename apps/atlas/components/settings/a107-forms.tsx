"use client";

import { Button, Checkbox, InlineAlert, Tag } from "@xos/ui";
import { useActionState } from "react";
import {
  choosePlanLimitKeepsAction,
  type PlanLimitChoiceState,
} from "./contributions/a107-actions";

/**
 * The Owner's choice of what stays writable for one plan limit (A107, ADR 0081): one checkbox per project or member the
 * limit counts, checked for those writable now. Owners' seats are always writable and cannot be unchecked. The
 * database caps the choice and recomputes the read-only objects; the outcome shows under the button.
 */

export interface PlanLimitOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly locked: boolean;
  readonly readOnly: boolean;
}

const INITIAL: PlanLimitChoiceState = {};

export function PlanLimitChoiceForm({
  org,
  limit,
  legend,
  options,
  labels,
}: {
  org: string;
  limit: string;
  legend: string;
  options: readonly PlanLimitOption[];
  labels: { save: string; owner: string; readOnly: string; writable: string };
}) {
  const [state, dispatch, pending] = useActionState(choosePlanLimitKeepsAction, INITIAL);
  return (
    <form
      action={dispatch}
      className="flex flex-col gap-12"
      data-testid={`plan-limit-form-${limit}`}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="limit" value={limit} />
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-label-13 font-medium">{legend}</legend>
        {options.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-8">
            <Checkbox
              name={o.locked ? undefined : "keep"}
              value={o.id}
              defaultChecked={o.locked || !o.readOnly}
              disabled={o.locked}
              label={o.detail ? `${o.label} (${o.detail})` : o.label}
            />
            <Tag tone={o.locked ? "neutral" : o.readOnly ? "warning" : "success"}>
              {o.locked ? labels.owner : o.readOnly ? labels.readOnly : labels.writable}
            </Tag>
          </div>
        ))}
      </fieldset>
      {state.message ? (
        <InlineAlert tone={state.ok ? "success" : "danger"}>{state.message}</InlineAlert>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          {labels.save}
        </Button>
      </div>
    </form>
  );
}
