"use client";

import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  saveMyNotificationsAction,
  saveOrgNotificationDefaultsAction,
  type NotificationFormState,
} from "@/app/[org]/settings/notification-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { MATRIX_CHANNELS } from "@/lib/settings/notification-matrix";

/**
 * The notification matrix forms (Section 4.5.6): a member's categories by channel with quiet hours and
 * digest (Personal settings, Notifications), and the org's defaults with mandatory categories
 * (Settings, Notifications). Each page has one form and its one primary action. A row carries a cell
 * only for the channels its category's kinds reach (A104); the other columns show no switch.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Option = { readonly value: string; readonly label: string };

export interface MemberCell {
  readonly channel: string;
  readonly enabled: boolean;
  readonly locked: boolean;
}

export interface MemberRow {
  readonly category: string;
  readonly urgent: boolean;
  readonly cells: readonly MemberCell[];
}

export interface OrgRow {
  readonly category: string;
  readonly urgent: boolean;
  readonly mandatory: boolean;
  readonly cells: readonly { readonly channel: string; readonly enabled: boolean }[];
}

export interface MemberSettings {
  readonly timeZone: string;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly digestFrequency: string;
  readonly digestHour: number;
}

const INITIAL: NotificationFormState = {};

function useCopy(): Translate {
  const t = useTranslations("settings.notifications" as "settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

function Status({ state }: { state: NotificationFormState }) {
  const t = useCopy();
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.fieldErrors) return <InlineAlert tone="danger">{t("errors.invalid")}</InlineAlert>;
  if (state.ok) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("saved")}
      </p>
    );
  }
  return null;
}

function CategoryHeader({ category, urgent }: { category: string; urgent: boolean }) {
  const t = useCopy();
  return (
    <th scope="row" className="py-8 pe-16 text-start align-top font-normal">
      <span className="block text-text-14 font-semibold">{t(`categories.${category}.label`)}</span>
      <span className="block text-text-13 text-text-secondary">
        {t(`categories.${category}.help`)}
        {urgent ? ` ${t("urgent")}` : ""}
      </span>
    </th>
  );
}

function ChannelHeaders({ extra }: { extra?: string }) {
  const t = useCopy();
  return (
    <thead>
      <tr className="border-b border-border-subtle text-text-13 text-text-secondary">
        <th scope="col" className="py-8 pe-16 text-start font-medium">
          {t("category")}
        </th>
        {MATRIX_CHANNELS.map((c) => (
          <th key={c.key} scope="col" className="px-8 py-8 text-center font-medium">
            {t(`channels.${c.key}`)}
          </th>
        ))}
        {extra ? (
          <th scope="col" className="px-8 py-8 text-center font-medium">
            {extra}
          </th>
        ) : null}
      </tr>
    </thead>
  );
}

/** A checkbox in a matrix cell, labeled for assistive technology by its row and column. */
function Cell({
  name,
  label,
  checked,
  disabled,
  note,
}: {
  name: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <td className="px-8 py-8 text-center align-top">
      <label className="inline-flex min-h-touch-min min-w-touch-min items-center justify-center">
        <input
          type="checkbox"
          name={name}
          defaultChecked={checked}
          disabled={disabled}
          aria-label={label}
          title={note}
          className="size-icon-16"
        />
      </label>
    </td>
  );
}

/** A column the category's kinds never reach: an empty cell, with a sentence saying so for assistive technology. */
function NotOffered({ label }: { label: string }) {
  return (
    <td className="px-8 py-8 text-center align-top">
      <span className="sr-only">{label}</span>
    </td>
  );
}

/** Personal settings, Notifications: the matrix, quiet hours and digest in one form. */
export function MyNotificationsForm({
  org,
  rows,
  settings,
  timeZones,
  sms,
}: {
  org: string;
  rows: readonly MemberRow[];
  settings: MemberSettings;
  timeZones: readonly Option[];
  /** The verified phone (masked) and whether the org may text it (1366). */
  sms: { readonly phone: string | null; readonly mayText: boolean };
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState(saveMyNotificationsAction, INITIAL);
  const field = (name: string) =>
    state.fieldErrors?.[name] ? t(`fieldErrors.${state.fieldErrors[name]}`) : "";
  const hours: Option[] = Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, "0")}:00`,
  }));
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("mine.formLabel")}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <section aria-labelledby="my-notifications-matrix" className="flex flex-col gap-8">
        <h2 id="my-notifications-matrix" className="m-0 text-heading-16 font-semibold">
          {t("mine.matrixTitle")}
        </h2>
        <p className="m-0 text-text-secondary">{t("mine.matrixDescription")}</p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-text-14">
            <ChannelHeaders />
            <tbody>
              {rows.map((row) => (
                <tr key={row.category} className="border-b border-border-subtle">
                  <CategoryHeader category={row.category} urgent={row.urgent} />
                  {MATRIX_CHANNELS.map(({ channel, key }) => {
                    const words = {
                      category: t(`categories.${row.category}.label`),
                      channel: t(`channels.${key}`),
                    };
                    const cell = row.cells.find((c) => c.channel === channel);
                    if (!cell) return <NotOffered key={channel} label={t("notOffered", words)} />;
                    const label = t("cellLabel", words);
                    return cell.locked ? (
                      <Cell
                        key={cell.channel}
                        name={`locked.${row.category}.${cell.channel}`}
                        label={`${label}. ${t("mine.locked")}`}
                        note={t("mine.locked")}
                        checked
                        disabled
                      />
                    ) : (
                      <Cell
                        key={cell.channel}
                        name={`cell.${row.category}.${cell.channel}`}
                        label={label}
                        checked={cell.enabled}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.flatMap((row) =>
          row.cells
            .filter((cell) => !cell.locked)
            .map((cell) => (
              <input
                key={`${row.category}.${cell.channel}`}
                type="hidden"
                name={`was.${row.category}.${cell.channel}`}
                value={cell.enabled ? "on" : "off"}
              />
            )),
        )}
        <p className="m-0 text-text-13 text-text-secondary">{t("mine.smsNote")}</p>
        {sms.phone === null ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("mine.smsNoPhone")}</p>
        ) : (
          <>
            <input type="hidden" name="smsConsentWas" value={sms.mayText ? "on" : "off"} />
            <Checkbox
              name="smsConsent"
              defaultChecked={sms.mayText}
              label={t("mine.smsConsent", { phone: sms.phone })}
            />
          </>
        )}
      </section>

      <section aria-labelledby="my-notifications-quiet" className="flex flex-col gap-12">
        <h2 id="my-notifications-quiet" className="m-0 text-heading-16 font-semibold">
          {t("mine.quietTitle")}
        </h2>
        <p className="m-0 text-text-secondary">{t("mine.quietDescription")}</p>
        <div className="flex flex-wrap items-end gap-12">
          <Input
            id="quiet-start"
            name="quietStart"
            type="time"
            label={t("mine.quietStart")}
            defaultValue={settings.quietStart}
            width={160}
            error={field("quietStart")}
          />
          <Input
            id="quiet-end"
            name="quietEnd"
            type="time"
            label={t("mine.quietEnd")}
            defaultValue={settings.quietEnd}
            width={160}
            error={field("quietEnd")}
          />
          <Select
            id="quiet-time-zone"
            name="timeZone"
            label={t("mine.timeZone")}
            value={settings.timeZone}
            options={[...timeZones]}
            error={field("timeZone")}
          />
        </div>
        <div className="flex flex-wrap items-end gap-12">
          <Select
            id="digest-frequency"
            name="digestFrequency"
            label={t("mine.digest")}
            help={t("mine.digestHelp")}
            value={settings.digestFrequency}
            options={["Off", "Daily", "Weekly"].map((f) => ({
              value: f,
              label: t(`digest.${f}`),
            }))}
            error={field("digestFrequency")}
          />
          <Select
            id="digest-hour"
            name="digestHour"
            label={t("mine.digestHour")}
            value={String(settings.digestHour)}
            options={hours}
            error={field("digestHour")}
          />
        </div>
      </section>
      <Status state={state} />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** Settings, Notifications: the org's default matrix with a mandatory switch per category. */
export function OrgNotificationDefaultsForm({
  org,
  rows,
  canEdit,
}: {
  org: string;
  rows: readonly OrgRow[];
  canEdit: boolean;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState(saveOrgNotificationDefaultsAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("org.formLabel")}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <section aria-labelledby="org-notifications-matrix" className="flex flex-col gap-8">
        <h2 id="org-notifications-matrix" className="m-0 text-heading-16 font-semibold">
          {t("org.matrixTitle")}
        </h2>
        <p className="m-0 text-text-secondary">{t("org.matrixDescription")}</p>
        {canEdit ? null : <InlineAlert tone="info">{t("org.readOnly")}</InlineAlert>}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-text-14">
            <ChannelHeaders extra={t("org.mandatory")} />
            <tbody>
              {rows.map((row) => (
                <tr key={row.category} className="border-b border-border-subtle">
                  <CategoryHeader category={row.category} urgent={row.urgent} />
                  {MATRIX_CHANNELS.map(({ channel, key }) => {
                    const words = {
                      category: t(`categories.${row.category}.label`),
                      channel: t(`channels.${key}`),
                    };
                    const cell = row.cells.find((c) => c.channel === channel);
                    if (!cell) return <NotOffered key={channel} label={t("notOffered", words)} />;
                    return (
                      <Cell
                        key={channel}
                        name={`default.${row.category}.${channel}`}
                        label={t("cellLabel", words)}
                        checked={cell.enabled}
                        disabled={!canEdit}
                      />
                    );
                  })}
                  <td className="px-8 py-8 text-center align-top">
                    <label className="inline-flex min-h-touch-min min-w-touch-min items-center justify-center">
                      <input
                        type="checkbox"
                        name="mandatory"
                        value={row.category}
                        defaultChecked={row.mandatory}
                        disabled={!canEdit}
                        aria-label={t("org.mandatoryLabel", {
                          category: t(`categories.${row.category}.label`),
                        })}
                        className="size-icon-16"
                      />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="m-0 text-text-13 text-text-secondary">{t("org.mandatoryHelp")}</p>
      </section>
      <Status state={state} />
      {canEdit ? (
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
