"use client";

import type { SensitiveCategory } from "@xos/data/sensitive-consent";
import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

// The step and its confirmation load with their first open, so the page carries none of their code.
const ConsentDialog = dynamic(() => import("./consent-dialog").then((m) => m.ConsentDialog));
const WithdrawDialog = dynamic(() => import("./consent-dialog").then((m) => m.WithdrawDialog));

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The consent step for a person's own sensitive data (ADR 0164): the fields stay out of the page until the person has
 * read what is collected, why, who sees it and how to withdraw, and agreed. Nothing here is required; every other form
 * on the page works without it. The database refuses a value without consent whatever the page does.
 */
export function ConsentGate({
  category,
  hidden,
  gateKey,
  reviewKey,
  waiting = false,
  held = false,
  onFile = [],
  attest = false,
}: {
  category: SensitiveCategory;
  hidden: Readonly<Record<string, string>>;
  /** `consent.gate.<gateKey>`: one line above the button. */
  gateKey: string;
  /** `consent.gate.<reviewKey>`: the button. */
  reviewKey: string;
  /** Values from before consent was recorded are on file, hidden from everyone else. */
  waiting?: boolean;
  /** The person withdrew, and a legal hold keeps what they entered hidden until it ends. */
  held?: boolean;
  /** What is on file, so the person sees what they are asked about. */
  onFile?: readonly string[];
  /** Someone declares it for a company: the step also asks for their two statements. */
  attest?: boolean;
}) {
  const t = useTranslations("workDetails.consent") as unknown as Translate;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-8">
      <p className="m-0 text-text-13 text-text-secondary">
        {waiting ? t("gate.waiting", { days: 30 }) : held ? t("gate.held") : t(`gate.${gateKey}`)}
      </p>
      {onFile.map((line) => (
        <p key={line} className="m-0 text-text-13">
          {line}
        </p>
      ))}
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {waiting ? t("gate.confirm") : t(`gate.${reviewKey}`)}
      </Button>
      {open ? (
        <ConsentDialog
          category={category}
          hidden={hidden}
          attest={attest}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Withdrawing is as easy as agreeing: one button and one confirmation, from the same place. */
export function ConsentWithdraw({
  category,
  hidden,
  labelKey,
}: {
  category: SensitiveCategory;
  hidden: Readonly<Record<string, string>>;
  /** `consent.withdrawAction.<labelKey>`: the button. */
  labelKey: string;
}) {
  const t = useTranslations("workDetails.consent") as unknown as Translate;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-4">
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t(`withdrawAction.${labelKey}`)}
      </Button>
      {open ? (
        <WithdrawDialog category={category} hidden={hidden} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
