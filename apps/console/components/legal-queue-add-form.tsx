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
  readonly holdsOrgData: boolean;
}

/**
 * Adds an item from a mailbox, a letter or a call. Times are typed in the zone every clock here counts in, which the form
 * names, and the database applies that zone's offset for the day entered, so nothing depends on the browser or on hydration.
 * The rule computes the clock. Only what the chosen rule needs shows, so the form stays short.
 */
export function LegalQueueAddForm({
  rules,
  timeZone,
}: {
  rules: readonly Rule[];
  /** The zone clocks count in, from the database. */
  timeZone: string;
}) {
  const t = useTranslations("console.legalQueue") as unknown as (
    key: string,
    values?: Record<string, string>,
  ) => string;
  const first = rules[0]?.code ?? "";
  const [code, setCode] = useState(first);
  const rule = rules.find((r) => r.code === code);
  return (
    // A successful add resets the form, and the rule it shows goes back with it.
    <div onReset={() => setCode(first)}>
      <ActionForm
        action={addLegalQueueItemAction}
        submitLabel={t("add.submit")}
        successLabel={t("add.done")}
        label={t("add.title")}
        testId="legal-queue-add"
      >
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
          help={t("add.receivedHelp", { zone: timeZone })}
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
        {rule?.holdsOrgData ? (
          <Input
            id="legal-add-org"
            name="orgSlug"
            label={t("add.org")}
            help={t("add.orgHelp")}
            maxLength={100}
            required
          />
        ) : null}
        {rule?.dueFromDocument ? (
          <Input
            id="legal-add-due"
            name="dueAt"
            type="datetime-local"
            label={t("add.due")}
            help={t("add.dueHelp", { zone: timeZone })}
            required
          />
        ) : null}
      </ActionForm>
    </div>
  );
}
