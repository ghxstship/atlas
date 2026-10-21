import { Input, Select, Textarea } from "@/components/ui";
import { EXPIRY_DAYS } from "@/lib/action-state";
import type { ConsoleT } from "@/lib/format";

/** Fields console forms share: the reason every change carries and the expiry of an override. */

export function ReasonField({
  t,
  id,
  maxLength = 500,
  multiline = false,
  label,
}: {
  t: ConsoleT;
  id: string;
  maxLength?: number;
  multiline?: boolean;
  label?: string;
}) {
  return multiline ? (
    <Textarea
      id={id}
      name="reason"
      label={label ?? t("common.reason")}
      help={t("common.reasonHelp")}
      required
      maxLength={maxLength}
      rows={2}
      width="100%"
    />
  ) : (
    <Input
      id={id}
      name="reason"
      label={label ?? t("common.reason")}
      help={t("common.reasonHelp")}
      required
      maxLength={maxLength}
      width="100%"
    />
  );
}

export function ExpiryField({ t, id, value = "30" }: { t: ConsoleT; id: string; value?: string }) {
  return (
    <Select
      id={id}
      name="days"
      label={t("common.expiresIn")}
      value={value}
      options={EXPIRY_DAYS.map((d) => ({
        value: String(d),
        label: t("common.days", { count: d }),
      }))}
    />
  );
}

export function OnOffField({
  t,
  id,
  name = "enabled",
}: {
  t: ConsoleT;
  id: string;
  name?: string;
}) {
  return (
    <Select
      id={id}
      name={name}
      label={t("tenant.value")}
      value="on"
      options={[
        { value: "on", label: t("common.on") },
        { value: "off", label: t("common.off") },
      ]}
    />
  );
}
