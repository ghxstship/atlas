"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useMemo } from "react";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { saveQuietHoursAction, type QuietHoursState } from "@/lib/actions/notifications";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Every IANA zone the runtime knows, for the zone picker. */
function zones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
}

/**
 * The person's own quiet hours (migration 1461, ADR 0033 decision 35): pushes from organizations
 * they are not a member of wait until the quiet hours end, read in the zone they choose. Members
 * keep per-organization quiet hours in Compass and Atlas.
 */
export function QuietHoursForm({
  timeZone,
  start,
  end,
}: {
  /** Saved zone, else the person's own locale.time_zone; empty when neither is known. */
  timeZone: string;
  start: string;
  end: string;
}) {
  const t = useTranslations("gateway.settings.quietHours") as unknown as Translate;
  const [state, action, pending] = useActionState<QuietHoursState, FormData>(
    saveQuietHoursAction,
    {},
  );
  const options = useMemo(() => zones(), []);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("title")}
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-12"
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("help")}</p>
      <div className="flex flex-wrap items-end gap-8">
        <Input id="quiet-start" name="start" type="time" label={t("start")} defaultValue={start} />
        <Input id="quiet-end" name="end" type="time" label={t("end")} defaultValue={end} />
        <Input
          id="quiet-zone"
          name="timeZone"
          label={t("zone")}
          defaultValue={timeZone}
          list="quiet-zone-options"
          required
        />
        <datalist id="quiet-zone-options">
          {options.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </div>
      {state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null}
      {state.saved ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("saved")}
        </p>
      ) : null}
      <div>
        <Button type="submit" loading={pending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
