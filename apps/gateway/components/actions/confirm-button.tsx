"use client";

import { Button, Dialog } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

type Translate = (key: string) => string;

/**
 * An irreversible bound server action confirmed in a dialog first (Section 11.10): leaving an account,
 * for one. On success the page refreshes; a refusal says what happened under the trigger.
 */
export function ConfirmButton({
  action,
  label,
  title,
  sentence,
  confirm,
  cancel,
}: {
  action: () => Promise<ActionResult>;
  label: string;
  title: string;
  sentence: string;
  confirm: string;
  cancel: string;
}) {
  const router = useRouter();
  const t = useTranslations("gateway.outcomes") as unknown as Translate;
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-4">
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button type="button" size="sm" variant="ghost">
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
              variant="danger"
              disabled={pending}
              aria-busy={pending}
              onClick={() =>
                start(async () => {
                  const next = await action();
                  setResult(next);
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
        {null}
      </Dialog>
      {result && !result.ok ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t(result.outcome)}
        </span>
      ) : null}
    </span>
  );
}
