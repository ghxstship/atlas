"use client";

import { Checkbox, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { saveBannerAction } from "@/lib/actions/operations";

const KINDS = ["Maintenance", "Incident", "Plan Notice", "Notice"] as const;
const SEVERITIES = ["Info", "Warning", "Critical"] as const;
const AUDIENCES = ["Everyone", "Atlas", "Gateway", "Compass"] as const;

/**
 * Publishes a system banner. Its window is entered in the operator's local time and sent with the browser's offset,
 * so the database stores instants (timestamptz), never a local date.
 */
export function BannerForm() {
  const t = useTranslations("console.banners");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("Info");
  return (
    <ActionForm
      action={saveBannerAction}
      submitLabel={t("publish")}
      successLabel={t("published")}
      label={t("new")}
      testId="banner-form"
    >
      {/* The browser's offset from UTC in minutes, written once the form reaches the browser. */}
      <input
        type="hidden"
        name="offset"
        defaultValue="0"
        ref={(el) => {
          // defaultValue too, so a reset after publishing keeps the offset.
          if (el) el.defaultValue = String(new Date().getTimezoneOffset());
        }}
      />
      <div className="flex flex-wrap gap-12">
        <Select
          id="banner-kind"
          name="kind"
          label={t("kind")}
          value="Notice"
          options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
        />
        <Select
          id="banner-severity"
          name="severity"
          label={t("severity")}
          value={severity}
          options={SEVERITIES.map((s) => ({ value: s, label: t(`severities.${s}`) }))}
          onChange={(e) => setSeverity(e.target.value as (typeof SEVERITIES)[number])}
        />
        <Select
          id="banner-audience"
          name="audience"
          label={t("audience")}
          value="Everyone"
          options={AUDIENCES.map((a) => ({ value: a, label: t(`audiences.${a}`) }))}
        />
      </div>
      <Textarea
        id="banner-message"
        name="message"
        label={t("message")}
        maxLength={300}
        rows={2}
        required
        width="100%"
      />
      <Textarea
        id="banner-message-es"
        name="messageEs"
        label={t("messageEs")}
        help={t("messageEsHelp")}
        maxLength={300}
        rows={2}
        width="100%"
      />
      <Input
        id="banner-link"
        name="linkUrl"
        type="url"
        label={t("link")}
        help={t("linkHelp")}
        width="100%"
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="banner-starts"
          name="startsAt"
          type="datetime-local"
          label={t("startsAt")}
          help={t("startsHelp")}
        />
        <Input
          id="banner-ends"
          name="endsAt"
          type="datetime-local"
          label={t("endsAt")}
          help={t("endsHelp")}
        />
      </div>
      {severity === "Critical" ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("dismissibleHelp")}</p>
      ) : (
        <Checkbox
          id="banner-dismissible"
          name="dismissible"
          label={t("dismissible")}
          defaultChecked
        />
      )}
    </ActionForm>
  );
}
