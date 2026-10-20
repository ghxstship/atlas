"use client";

import { Button, Textarea } from "@xos/ui";
import { useActionState, useState } from "react";
import type { FormResult } from "@/lib/actions/operations";
import { respondSponsorAssetAction } from "@/lib/actions/sponsor";
import { FormShell, useCopy } from "./forms";

/**
 * The sponsor's answer on one brand asset (journey 47): approve or return a submitted asset (a
 * return says what to change), or resubmit a returned one as a new revision.
 */
export function SponsorAssetForm(props: {
  assetId: string;
  title: string;
  state: "Submitted" | "Returned";
}) {
  const t = useCopy();
  const [result, action, pending] = useActionState<FormResult, FormData>(
    respondSponsorAssetAction,
    {},
  );
  const [next, setNext] = useState<"Approved" | "Returned" | "Submitted">(
    props.state === "Submitted" ? "Approved" : "Submitted",
  );
  const label =
    next === "Approved"
      ? t("asset.approve")
      : next === "Returned"
        ? t("asset.return")
        : t("asset.resubmit");
  return (
    <FormShell
      row
      state={result}
      pending={pending}
      action={action}
      submitLabel={label}
      doneLabel={t("asset.done")}
      label={props.title}
    >
      <input type="hidden" name="assetId" value={props.assetId} />
      <input type="hidden" name="expected" value={props.state} />
      <input type="hidden" name="next" value={next} />
      {props.state === "Submitted" ? (
        <fieldset className="m-0 flex flex-wrap gap-8 border-0 p-0">
          <legend className="sr-only">{t("asset.decision")}</legend>
          {(["Approved", "Returned"] as const).map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={next === d ? "secondary" : "ghost"}
              aria-pressed={next === d}
              onClick={() => setNext(d)}
            >
              {d === "Approved" ? t("asset.approve") : t("asset.return")}
            </Button>
          ))}
        </fieldset>
      ) : null}
      <Textarea
        id={`asset-${props.assetId}`}
        name="reason"
        rows={2}
        width="100%"
        label={next === "Returned" ? t("asset.reason") : t("asset.note")}
        required={next === "Returned"}
      />
    </FormShell>
  );
}
