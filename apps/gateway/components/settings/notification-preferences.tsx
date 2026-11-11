"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  saveNotificationPreferencesAction,
  type PreferencesState,
} from "@/lib/actions/notifications";
import { keepInputOnSubmit } from "@/components/forms/keep-input";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface PreferenceRow {
  readonly category: string;
  readonly channel: string;
  readonly enabled: boolean;
}

/**
 * The external party's notification choices (migration 1131): one group per category with a checkbox for
 * each channel its kinds reach, Email and Push at most (partyChannels, A104), so no switch offers a channel
 * that cannot deliver. In-app notifications always show on Home.
 */
export function NotificationPreferences({ rows }: { rows: readonly PreferenceRow[] }) {
  const t = useTranslations("gateway.settings.notifications") as unknown as Translate;
  const [state, action, pending] = useActionState<PreferencesState, FormData>(
    saveNotificationPreferencesAction,
    {},
  );
  const categories = [...new Set(rows.map((r) => r.category))];
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("formLabel")}
      className="flex flex-col gap-12"
    >
      {categories.map((category) => (
        <fieldset
          key={category}
          className="m-0 flex flex-col gap-8 rounded-card border border-border-subtle p-12"
        >
          <legend className="px-4 text-text-14 font-semibold">
            {t(`categories.${category}.label`)}
          </legend>
          <p className="m-0 text-text-13 text-text-secondary">{t(`categories.${category}.help`)}</p>
          <div className="flex flex-wrap gap-16">
            {rows
              .filter((r) => r.category === category)
              .map((r) => (
                <label
                  key={r.channel}
                  className="flex min-h-touch-min items-center gap-8 text-text-14"
                >
                  <input
                    type="checkbox"
                    name={`${category}.${r.channel}`}
                    defaultChecked={r.enabled}
                    className="size-icon-16"
                  />
                  {t(`channels.${r.channel}`)}
                </label>
              ))}
          </div>
        </fieldset>
      ))}
      {state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null}
      {state.saved ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("saved")}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
