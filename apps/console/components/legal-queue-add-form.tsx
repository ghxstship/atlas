"use client";

import type { LegalQueueMatter } from "@xos/data/console-legal-queue";
import { Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { addLegalQueueItemAction } from "@/lib/actions/legal-queue";

interface Rule {
  readonly code: string;
  readonly matter: LegalQueueMatter;
  readonly dueFromDocument: boolean;
}

/**
 * Adds an item from a mailbox, a letter or a call. The operator says when it arrived, in their local time, sent with the
 * browser's offset so the database stores an instant; the rule computes the clock. Only what the chosen rule needs shows,
 * so the form stays short.
 */
export function LegalQueueAddForm({ rules }: { rules: readonly Rule[] }) {
  const t = useTranslations("console.legalQueue") as unknown as (key: string) => string;
  const first = rules[0]?.code ?? "";
  const [code, setCode] = useState(first);
  const rule = rules.find((r) => r.code === code);
  return (
    <ActionForm
      action={addLegalQueueItemAction}
      submitLabel={t("add.submit")}
      successLabel={t("add.done")}
      label={t("add.title")}
      testId="legal-queue-add"
    >
      {/* The browser's offset from UTC in minutes, written once the form reaches the browser. */}
      <input
        type="hidden"
        name="offset"
        defaultValue="0"
        ref={(el) => {
          // defaultValue too, so a reset after adding keeps the offset.
          if (el) el.defaultValue = String(new Date().getTimezoneOffset());
        }}
      />
      <Select
        id="legal-add-rule"
        name="ruleCode"
        label={t("add.rule")}
        value={code}
        options={rules.map((r) => ({ value: r.code, label: t(`rules.${r.code}.label`) }))}
        onChange={(e) => setCode(e.target.value)}
      />
      {rule ? (
        <p className="m-0 max-w-prose text-text-12 text-text-secondary" data-testid="rule-source">
          {t(`rules.${rule.code}.source`)}
        </p>
      ) : null}
      <Input
        id="legal-add-title"
        name="title"
        label={t("add.titleField")}
        help={t("add.titleHelp")}
        maxLength={200}
        required
        width="100%"
      />
      <Input
        id="legal-add-received"
        name="receivedAt"
        type="datetime-local"
        label={t("add.received")}
        help={t("add.receivedHelp")}
        required
      />
      <Input
        id="legal-add-contact"
        name="requesterContact"
        label={t("add.contact")}
        maxLength={320}
        width="100%"
      />
      <Textarea
        id="legal-add-details"
        name="details"
        label={t("add.details")}
        help={t("add.detailsHelp")}
        maxLength={4000}
        rows={2}
        width="100%"
      />
      {rule?.matter === "DMCA Notice" ? (
        <Input
          id="legal-add-subject"
          name="subjectEmail"
          type="email"
          label={t("add.subject")}
          help={t("add.subjectHelp")}
          width="100%"
        />
      ) : null}
      {rule?.matter === "DMCA Counter-Notice" ? (
        <Input
          id="legal-add-related"
          name="relatedReference"
          label={t("add.related")}
          help={t("add.relatedHelp")}
          required
        />
      ) : null}
      {rule?.dueFromDocument ? (
        <Input
          id="legal-add-due"
          name="dueAt"
          type="datetime-local"
          label={t("add.due")}
          help={t("add.dueHelp")}
          required
        />
      ) : null}
    </ActionForm>
  );
}
