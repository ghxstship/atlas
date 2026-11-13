"use client";

import { Button, Dialog, Textarea, type ButtonProps } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";

/** The confirmation behind ConfirmButton, loaded when it opens so the page ships only the trigger. */
export function ConfirmDialog({
  action,
  title,
  sentence,
  confirm,
  cancel,
  reason,
  confirmVariant,
  children,
  setOpen,
  onResult,
}: {
  action: (reason?: string | null) => Promise<ActionResult>;
  title: string;
  sentence: string;
  confirm: string;
  cancel: string;
  reason?: string | undefined;
  confirmVariant: NonNullable<ButtonProps["variant"]>;
  children?: ReactNode;
  setOpen: (open: boolean) => void;
  onResult: (result: ActionResult) => void;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog
      open
      onOpenChange={(next) => setOpen(next)}
      title={title}
      description={sentence}
      actions={
        <>
          <Button type="button" onClick={() => setOpen(false)}>
            {cancel}
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            disabled={pending}
            aria-busy={pending}
            onClick={() =>
              start(async () => {
                const next = reason ? await action(text.trim() || null) : await action();
                onResult(next);
                setOpen(false);
                if (next.ok) router.refresh();
              })
            }
          >
            {confirm}
          </Button>
        </>
      }
    >
      {children || reason ? (
        <div className="flex flex-col gap-12">
          {children}
          {reason ? (
            <Textarea
              id={reasonId}
              label={reason}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              rows={3}
              width="100%"
            />
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
