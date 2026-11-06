"use client";

import { Button, InlineAlert, Input, Select } from "@xos/ui";
import { useActionState, useId } from "react";
import { bookDockSlotAction, setNamesDueAction, type AdvancingState } from "./actions";
import { useCopy } from "./use-copy";

/**
 * Small forms of typed advance answers and recipients (R9): booking an Accepted Load In or Load
 * Out window as a dock slot, and setting a recipient's naming deadline (G-141), which stays
 * editable after the packet is sent.
 */

export function BookDockSlotForm({
  org,
  lineId,
  zones,
}: {
  org: string;
  lineId: string;
  zones: readonly { value: string; label: string }[];
}) {
  const t = useCopy("advancing.bookDock");
  const errors = useCopy("advancing.errors");
  const [state, action, pending] = useActionState<AdvancingState, FormData>(bookDockSlotAction, {});
  const id = useId();
  if (state.ok) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("done")}
      </p>
    );
  }
  if (zones.length === 0)
    return <p className="m-0 text-text-12 text-text-secondary">{t("noZones")}</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-8" aria-label={t("title")}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="lineId" value={lineId} />
      <Select
        id={`${id}-zone`}
        name="zoneId"
        label={t("zone")}
        options={[...zones]}
        value={zones[0]?.value ?? ""}
      />
      <Button type="submit" size="sm" icon="Truck" loading={pending}>
        {t("submit")}
      </Button>
      {state.error ? (
        <div className="basis-full">
          <InlineAlert tone="danger">{errors(state.error)}</InlineAlert>
        </div>
      ) : null}
    </form>
  );
}

export function SetNamesDueForm({
  org,
  recipientId,
  timeZone,
  current,
}: {
  org: string;
  recipientId: string;
  timeZone: string;
  /** The deadline as a datetime-local value in the project's zone, or empty. */
  current: string;
}) {
  const t = useCopy("advancing.recipients.namesDue");
  const errors = useCopy("advancing.errors");
  const [state, action, pending] = useActionState<AdvancingState, FormData>(setNamesDueAction, {});
  const id = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-8" aria-label={t("set")}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="recipientId" value={recipientId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <Input
        id={`${id}-at`}
        name="namesDueAt"
        type="datetime-local"
        label={t("label")}
        help={t("help", { zone: timeZone })}
        defaultValue={current}
        error={state.fieldErrors?.["namesDueAt"] ? t("error") : ""}
      />
      <Button type="submit" size="sm" loading={pending}>
        {t("set")}
      </Button>
      {state.ok ? (
        <span role="status" className="text-text-12 text-success-text">
          {t("saved")}
        </span>
      ) : null}
      {state.error ? (
        <div className="basis-full">
          <InlineAlert tone="danger">{errors(state.error)}</InlineAlert>
        </div>
      ) : null}
    </form>
  );
}
