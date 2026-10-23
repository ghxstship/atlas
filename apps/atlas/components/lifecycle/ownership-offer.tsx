"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { acceptOwnershipAction, declineOwnershipAction } from "@/lib/lifecycle/actions";
import { INITIAL_PLATFORM_STATE, type PlatformActionState } from "@/lib/platform/state";

/**
 * Accept or decline an ownership offer, from the org banner of the member it was made to (A79, Section 14.7:
 * "the new Owner must accept and pass MFA"). Accepting needs a recent second factor: a step_up_required refusal
 * opens A77's step-up dialog, rendered outside the form, and verifying submits the acceptance again. The labels
 * and refusal copy come from the server banner, so this ships no catalog.
 */

const stepUpRefused = (state: PlatformActionState) => state.rule === "step_up_required";
const buttonClass =
  "inline-flex h-control-sm items-center rounded-control px-12 text-label-13 font-medium focus-visible:outline-2 disabled:opacity-60";

export function OwnershipOfferActions({
  org,
  transfer,
  acceptLabel,
  declineLabel,
  refusals,
}: {
  org: string;
  transfer: string;
  acceptLabel: string;
  declineLabel: string;
  /** Copy for each refusal an answer can meet, keyed by rule, with `other` for the rest. */
  refusals: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const acceptForm = useRef<HTMLFormElement>(null);
  const [accepted, accept, accepting] = useActionState(
    acceptOwnershipAction,
    INITIAL_PLATFORM_STATE,
  );
  const [declined, decline, declining] = useActionState(
    declineOwnershipAction,
    INITIAL_PLATFORM_STATE,
  );
  const dialog = useStepUpForm(accepted, stepUpRefused, acceptForm);
  useEffect(() => {
    if (accepted.ok || declined.ok) router.refresh();
  }, [accepted, declined, router]);
  const latest = (accepted.at ?? 0) >= (declined.at ?? 0) ? accepted : declined;
  const refusal = latest.rule ?? (latest.error ? "other" : null);
  return (
    <>
      <span className="flex flex-wrap items-center gap-8">
        <form ref={acceptForm} action={accept}>
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="transfer" value={transfer} />
          <button
            type="submit"
            disabled={accepting || declining}
            className={`${buttonClass} bg-accent-default text-accent-text-on`}
          >
            {acceptLabel}
          </button>
        </form>
        <form action={decline}>
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="transfer" value={transfer} />
          <button
            type="submit"
            disabled={accepting || declining}
            className={`${buttonClass} border border-border-control text-text-primary`}
          >
            {declineLabel}
          </button>
        </form>
      </span>
      {refusal ? (
        <span role="alert" className="text-text-13">
          {refusals[refusal] ?? refusals["other"]}
        </span>
      ) : null}
      {dialog}
    </>
  );
}
