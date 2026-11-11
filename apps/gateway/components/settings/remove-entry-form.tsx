"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useActionState } from "react";
import {
  disownSensitiveEntryAction,
  removeSensitiveEntryAction,
  type WorkDetailsFormState,
} from "@/lib/actions/work-details";

const INITIAL: WorkDetailsFormState = {};

/**
 * One step on what someone else entered: remove it, or, for a guest list entry an email matched, say the guest is someone
 * else. A failed step says so, because the data is still on file.
 */
export function RemoveEntryForm({
  hidden,
  consentId,
  label,
  failed,
  disown = false,
  accessibleLabel,
}: {
  hidden: Readonly<Record<string, string>>;
  consentId: string;
  label: string;
  failed: string;
  /** Says the guest list entry is about someone else instead of removing it. */
  disown?: boolean;
  /** A name that tells this step from the same one on another row. */
  accessibleLabel?: string;
}) {
  const [state, action, pending] = useActionState(
    disown ? disownSensitiveEntryAction : removeSensitiveEntryAction,
    INITIAL,
  );
  return (
    <form action={action} className="flex flex-col items-end gap-4">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="consentId" value={consentId} />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        loading={pending}
        {...(accessibleLabel ? { "aria-label": accessibleLabel } : {})}
      >
        {label}
      </Button>
      {state.error ? <InlineAlert tone="danger">{failed}</InlineAlert> : null}
    </form>
  );
}
