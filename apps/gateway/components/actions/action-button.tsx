"use client";

import { Button, InlineAlert, type ButtonProps } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

type Translate = (key: string) => string;

/**
 * One button that runs a bound server action (sign, accept, decline, withdraw, revoke). It shows
 * progress without a blocking spinner, refreshes the page on success and, on a refusal, says what
 * happened and how to fix it in one sentence under the button (Section 11.10, rules 9 and 11).
 */
export function ActionButton({
  action,
  label,
  variant = "secondary",
  size = "sm",
  icon,
  done,
}: {
  action: () => Promise<ActionResult>;
  label: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  icon?: string;
  /** Shown after success when the row stays on screen. */
  done?: string;
}) {
  const router = useRouter();
  const t = useTranslations("gateway.outcomes") as unknown as Translate;
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-4">
      <Button
        variant={variant}
        size={size}
        {...(icon ? { icon } : {})}
        disabled={pending}
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            const next = await action();
            setResult(next);
            if (next.ok) router.refresh();
          })
        }
      >
        {label}
      </Button>
      {result && !result.ok ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t(result.outcome)}
        </span>
      ) : null}
      {result?.ok && done ? (
        <span role="status" className="text-text-12 text-success-text">
          {done}
        </span>
      ) : null}
    </span>
  );
}

/** A form-level outcome for forms built with useActionState. */
export function OutcomeAlert({ outcome }: { outcome: string | undefined }) {
  const t = useTranslations("gateway.outcomes") as unknown as Translate;
  if (!outcome) return null;
  return <InlineAlert tone="danger">{t(outcome)}</InlineAlert>;
}
