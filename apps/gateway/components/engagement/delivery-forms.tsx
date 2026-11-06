"use client";

import { Button, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useTransition, useState } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import type { FormResult } from "@/lib/actions/operations";
import {
  bookDeliveryAction,
  cancelDeliveryBookingAction,
  changeDeliveryPlateAction,
} from "@/lib/actions/deliveries";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { FormShell } from "./forms";

interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * Book a delivery (B11, G-115): a window, a plate and, when the vendor carries one, a shipment. The event id is rendered
 * with the form, so a second click replays the same booking. The reference code appears on the booking's row once it is
 * made, not in a control that leaves after the refresh.
 */
export function DeliveryBookingForm({
  eventId,
  engagementId,
  windows,
  shipments,
}: {
  eventId: string;
  engagementId: string;
  windows: readonly Option[];
  shipments: readonly Option[];
}) {
  const t = useTranslations("gateway.engagement.deliveries.book");
  const [state, action, pending] = useActionState<FormResult, FormData>(bookDeliveryAction, {});
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("submit")}
      doneLabel={t("done")}
      label={t("title")}
      row
    >
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="engagementId" value={engagementId} />
      <Select id="delivery-window" name="windowId" label={t("window")} options={[...windows]} />
      <Input
        id="delivery-plate"
        name="vehicleIdentifier"
        maxLength={40}
        label={t("plate")}
        help={t("plateHelp")}
      />
      {shipments.length > 0 ? (
        <Select
          id="delivery-shipment"
          name="shipmentId"
          label={t("shipment")}
          options={[{ value: "", label: t("noShipment") }, ...shipments]}
        />
      ) : null}
    </FormShell>
  );
}

/**
 * Cancel and Change plate on a booking's row. The database says when it is too late (delivery_booking_locked). Each
 * success refreshes the tab, so the row leaves or shows the new plate; a refusal keeps what was typed.
 */
export function DeliveryBookingActions({
  slotId,
  plate,
}: {
  slotId: string;
  plate: string | null;
}) {
  const t = useTranslations("gateway.engagement.deliveries.book");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [state, action, saving] = useActionState<FormResult, FormData>(
    changeDeliveryPlateAction,
    {},
  );
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.done) setEditing(false);
  }
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state, router]);
  return (
    <div className="flex flex-col gap-8">
      <OutcomeAlert outcome={outcome ?? state.outcome} />
      {editing ? (
        <form
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-wrap items-end gap-8"
        >
          <input type="hidden" name="slotId" value={slotId} />
          <Input
            id={`plate-${slotId}`}
            name="vehicleIdentifier"
            maxLength={40}
            defaultValue={plate ?? ""}
            label={t("plate")}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={saving}>
            {t("savePlate")}
          </Button>
        </form>
      ) : (
        <div className="flex gap-8">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {t("changePlate")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await cancelDeliveryBookingAction(slotId);
                setOutcome(result.ok ? undefined : result.outcome);
                if (result.ok) router.refresh();
              })
            }
          >
            {t("cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
