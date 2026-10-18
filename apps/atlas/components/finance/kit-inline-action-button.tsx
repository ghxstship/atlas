"use client";

import { Button } from "@xos/ui";
import { useActionState, useTransition } from "react";
import { type ActionState } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";

/** Submits a server action with no fields beyond those given, for small inline actions. */
export function InlineActionButton({
  action,
  fields,
  label,
  variant = "ghost",
  icon,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  fields: Readonly<Record<string, string>>;
  label: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  icon?: "Trash2" | "X" | "Undo2";
}) {
  const [state, run, pending] = useActionState(action, {});
  const [, start] = useTransition();
  return (
    <span className="inline-flex flex-col gap-4">
      <Button
        variant={variant}
        size="sm"
        loading={pending}
        {...(icon ? { icon } : {})}
        onClick={() => {
          const form = new FormData();
          for (const [k, v] of Object.entries(fields)) form.set(k, v);
          start(() => run(form));
        }}
      >
        {label}
      </Button>
      <ActionFeedback state={state} />
    </span>
  );
}
