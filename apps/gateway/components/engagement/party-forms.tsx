"use client";

import { Button, Input, Textarea } from "@xos/ui";
import { useActionState, useState } from "react";
import { requestGuestAction, respondSettlementAction } from "@/lib/actions/party";
import type { FormResult } from "@/lib/actions/operations";
import { FormShell, useCopy } from "./forms";

/** Requests a guest on the engagement's list (Artist tab Guest List). */
export function GuestRequestForm({ engagementId }: { engagementId: string }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(requestGuestAction, {});
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("guest.submit")}
      doneLabel={t("guest.done")}
      label={t("guest.title")}
    >
      <input type="hidden" name="engagementId" value={engagementId} />
      <div className="flex flex-wrap gap-8">
        <Input id="guest-name" name="guestName" required maxLength={200} label={t("guest.name")} />
        <Input
          id="guest-plus-ones"
          name="plusOnes"
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          defaultValue="0"
          label={t("guest.plusOnes")}
        />
        <Input
          id="guest-email"
          name="guestEmail"
          type="email"
          autoComplete="off"
          maxLength={320}
          label={t("guest.email")}
          help={t("guest.emailHelp")}
        />
      </div>
      <Textarea
        id="guest-note"
        name="note"
        rows={2}
        maxLength={500}
        width="100%"
        label={t("guest.note")}
      />
    </FormShell>
  );
}

/** Accepts or disputes a submitted settlement, always with a reason (Artist tab Settlement). */
export function SettlementResponseForm({
  settlementId,
  title,
}: {
  settlementId: string;
  title: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    respondSettlementAction,
    {},
  );
  const [decision, setDecision] = useState<"accept" | "dispute">("accept");
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={decision === "accept" ? t("settlement.accept") : t("settlement.dispute")}
      doneLabel={t("settlement.done")}
      label={title}
    >
      <input type="hidden" name="settlementId" value={settlementId} />
      <input type="hidden" name="decision" value={decision} />
      <fieldset className="m-0 flex flex-wrap gap-8 border-0 p-0">
        <legend className="sr-only">{t("settlement.decision")}</legend>
        {(["accept", "dispute"] as const).map((d) => (
          <Button
            key={d}
            type="button"
            size="sm"
            variant={decision === d ? "secondary" : "ghost"}
            aria-pressed={decision === d}
            onClick={() => setDecision(d)}
          >
            {d === "accept" ? t("settlement.accept") : t("settlement.dispute")}
          </Button>
        ))}
      </fieldset>
      <Textarea
        id={`settlement-${settlementId}`}
        name="reason"
        required
        rows={2}
        maxLength={2000}
        width="100%"
        label={decision === "accept" ? t("settlement.note") : t("settlement.reason")}
      />
    </FormShell>
  );
}
