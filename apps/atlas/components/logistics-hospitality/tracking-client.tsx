"use client";

import { Button, InlineAlert, Input, Select, Tag } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { useCopy } from "@/components/collection-kit/use-copy";
import { startTrackingAction, stopTrackingAction, type TrackingState } from "./tracking-actions";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/** Starts carrier tracking on a shipment through one of the org's Connected carriers. */
export function StartTrackingForm({
  org,
  shipmentId,
  carriers,
  trackingNumber,
}: {
  org: string;
  shipmentId: string;
  carriers: readonly { id: string; label: string }[];
  trackingNumber: string | null;
}) {
  const t = useCopy("shipmentTracking");
  const id = useId();
  const router = useRouter();
  const [state, action, pending] = useActionState<TrackingState, FormData>(startTrackingAction, {});
  const [carrier, setCarrier] = useState(carriers[0]?.id ?? "");
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("start")}
      className="flex flex-col gap-8"
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <input type="hidden" name="connectionId" value={carrier} />
      {state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null}
      <div className="flex flex-wrap items-end gap-8">
        <Select
          label={t("carrier")}
          value={carrier}
          options={carriers.map((c) => ({ value: c.id, label: c.label }))}
          onChange={(e) => setCarrier(e.target.value)}
        />
        <Input
          id={`${id}-number`}
          name="trackingNumber"
          label={t("number")}
          help={
            trackingNumber ? t("numberFromShipment", { number: trackingNumber }) : t("numberHint")
          }
          autoComplete="off"
        />
        <Button type="submit" size="sm" icon="Truck" loading={pending}>
          {t("start")}
        </Button>
      </div>
    </form>
  );
}

/** Stops tracking; the scan history stays on the shipment. */
export function StopTrackingButton({ org, trackerId }: { org: string; trackerId: string }) {
  const t = useCopy("shipmentTracking");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<TrackingState>({});
  return (
    <span className="inline-flex flex-col items-start gap-4">
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        onClick={() =>
          start(async () => {
            const next = await stopTrackingAction(org, trackerId);
            setState(next);
            if (next.ok) router.refresh();
          })
        }
      >
        {t("stop")}
      </Button>
      {state.error ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t(`errors.${state.error}`)}
        </span>
      ) : null}
    </span>
  );
}

/** The tracking status chip (the design system's Tag is a client component). */
export function StatusTag({
  tone,
  label,
}: {
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  label: string;
}) {
  return <Tag tone={tone}>{label}</Tag>;
}
