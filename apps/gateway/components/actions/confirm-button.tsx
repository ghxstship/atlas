"use client";

import { Button, type ButtonProps } from "@xos/ui";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";

const ConfirmDialog = dynamic(() => import("./confirm-dialog").then((m) => m.ConfirmDialog));

type Translate = (key: string) => string;

/**
 * An irreversible bound server action confirmed in a dialog first (Section 11.10): leaving an account,
 * for one. On success the page refreshes; a refusal says what happened under the trigger. With `reason`,
 * the dialog asks for an optional reason of up to 500 characters and passes it to the action, trimmed,
 * or null when blank (declining an offer or a shift). `confirmVariant` keeps the danger button for what
 * cannot be undone; a certification that can be corrected later confirms with the primary one. The dialog
 * loads when the trigger is pressed (confirm-dialog.tsx), so a page ships only the button.
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
  const t = useTranslations("gateway.outcomes") as unknown as Translate;
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-4">
      <Button
        type="button"
        size="sm"
        variant={triggerVariant}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {open ? (
        <ConfirmDialog
          action={action}
          title={title}
          sentence={sentence}
          confirm={confirm}
          cancel={cancel}
          reason={reason}
          confirmVariant={confirmVariant}
          setOpen={setOpen}
          onResult={setResult}
        >
          {children}
        </ConfirmDialog>
      ) : null}
      {result && !result.ok ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t(result.outcome)}
        </span>
      ) : null}
    </span>
  );
}
