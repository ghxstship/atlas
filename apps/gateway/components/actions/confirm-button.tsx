"use client";

import { Button, Dialog, Textarea, type ButtonProps } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";

type Translate = (key: string) => string;

/**
 * An irreversible bound server action confirmed in a dialog first (Section 11.10): leaving an account,
 * for one. On success the page refreshes; a refusal says what happened under the trigger. With `reason`,
 * the dialog asks for an optional reason of up to 500 characters and passes it to the action, trimmed,
 * or null when blank (declining an offer or a shift). `confirmVariant` keeps the danger button for what
 * cannot be undone; a certification that can be corrected later confirms with the primary one.
 */
export function ConfirmButton({
  action,
  label,
  title,
  sentence,
  confirm,
  cancel,
  reason,
  triggerVariant = "ghost",
  confirmVariant = "danger",
  children,
}: {
  action: (reason?: string | null) => Promise<ActionResult>;
  label: string;
  title: string;
  sentence: string;
  confirm: string;
  cancel: string;
  /** The label of an optional reason field; leave it out for a plain confirmation. */
  reason?: string;
  triggerVariant?: ButtonProps["variant"];
  confirmVariant?: ButtonProps["variant"];
  /** Anything else the person reads before confirming, such as a warning. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations("gateway.outcomes") as unknown as Translate;
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-4">
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button type="button" size="sm" variant={triggerVariant}>
            {label}
          </Button>
        }
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
                  setResult(next);
                  setOpen(false);
                  if (next.ok) {
                    setText("");
                    router.refresh();
                  }
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
      {result && !result.ok ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t(result.outcome)}
        </span>
      ) : null}
    </span>
  );
}
