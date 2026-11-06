"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useActionState } from "react";
import { removeSensitiveEntryAction, type WorkDetailsFormState } from "@/lib/work-details/actions";

const INITIAL: WorkDetailsFormState = {};

/** One step to remove what someone else entered; a failed removal says so, because the data is still on file. */
export function RemoveEntryForm({
  hidden,
  consentId,
  label,
  failed,
}: {
  hidden: Readonly<Record<string, string>>;
  consentId: string;
  label: string;
  failed: string;
}) {
  const [state, action, pending] = useActionState(removeSensitiveEntryAction, INITIAL);
  return (
    <form action={action} className="flex flex-col items-end gap-4">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="consentId" value={consentId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        {label}
      </Button>
      {state.error ? <InlineAlert tone="danger">{failed}</InlineAlert> : null}
    </form>
  );
}
