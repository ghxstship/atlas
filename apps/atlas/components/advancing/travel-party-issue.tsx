"use client";

import type { Route } from "next";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { AllocationRowProps, IssuePrefill } from "./allocation-dialogs";

const IssueAllocationDialog = dynamic(() =>
  import("./allocation-dialogs").then((m) => m.IssueAllocationDialog),
);

/**
 * R7's Issue dialog for the travel party (R5 correction 8, built by B5): Assign room and Add pickup open it when the
 * person has an Approved Lodging or Travel allocation not yet fully issued, prefilled from the travel request. Closing
 * it returns to the travel party.
 */
export function TravelPartyIssue({
  org,
  row,
  prefill,
  closeHref,
}: {
  org: string;
  row: AllocationRowProps;
  prefill: IssuePrefill;
  closeHref: string;
}) {
  const router = useRouter();
  return (
    <IssueAllocationDialog
      org={org}
      row={row}
      open
      onOpenChange={(open) => {
        if (!open) router.replace(closeHref as Route, { scroll: false });
      }}
      prefill={prefill}
    />
  );
}
