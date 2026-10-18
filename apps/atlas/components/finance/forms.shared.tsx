"use client";

import { Button } from "@xos/ui";
import { type ActionState } from "@/app/[org]/finance/actions";

/**
 * Create and edit forms for every finance document (A15). Each keeps typed input after a failed
 * submit, names the field at fault (Section 11.10 rule 11), and shows database refusals with their
 * rule. Money fields take major units; a blank price is unpriced and stays NULL (Section 3.7).
 * At most seven fields show before "More fields" (Section 11.10 cognitive load budget).
 */

export const INITIAL: ActionState = {};

export function Submit({ label, pending }: { label: string; pending: boolean }) {
  return (
    <div className="flex items-center gap-12">
      <Button type="submit" variant="primary" loading={pending}>
        {label}
      </Button>
    </div>
  );
}
