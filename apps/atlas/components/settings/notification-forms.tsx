"use client";

import { Accordion, Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";
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
 * (Settings, Notifications). Each page has one form and its one primary action.
 *
 * Fifteen categories by four channels is 60 checkboxes, far past the seven fields a form shows before
 * More fields (Section 11.10, gate 27). So each category is a section of its own that says which
 * channels are on and opens to change them; closed sections stay in the form, so every cell submits.
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

/** The checked boxes of a group (`category.channel` cells, or mandatory categories) as they change. */
function useChecked(initial: () => Iterable<string>) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial()));
  const set = (key: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return [checked, set] as const;
}

/** The channels of a category that are on, in column order: "In app, Email", or Off. */
function useSummary() {
  const t = useCopy();
  return (category: string, on: ReadonlySet<string>) => {
    const names = MATRIX_CHANNELS.filter((c) => on.has(`${category}.${c.channel}`)).map((c) =>
      t(`channels.${c.key}`),
    );
    return names.length > 0 ? names.join(", ") : t("summaryOff");
  };
}

/** One category's section: what it is, then a checkbox per channel and anything else it needs. */
function CategoryChoices({
  category,
  urgent,
  children,
}: {
  category: string;
  urgent: boolean;
  children: ReactNode;
}) {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-8 text-text-primary">
      <p className="m-0 text-text-13 text-text-secondary">
        {t(`categories.${category}.help`)}
        {urgent ? ` ${t("urgent")}` : ""}
      </p>
      <div className="flex flex-wrap gap-x-16 gap-y-4">{children}</div>
    </div>
  );
}

/** A checkbox for one channel, named for assistive technology by its category and channel. */
function Cell({
  name,
  label,
  channel,
  checked,
  onChange,
  disabled,
  value,
  note,
}: {
  name: string;
  label: string;
  channel: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  value?: string;
  /** Why the box cannot change, as a tooltip. */
  note?: string;
}) {
  return (
    <label className="inline-flex min-h-touch-min items-center gap-8 text-text-14">
      <input
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        onChange={(e) => onChange?.(e.currentTarget.checked)}
        disabled={disabled}
        aria-label={label}
        title={note}
        className="size-icon-16"
      />
      <span>{channel}</span>
    </label>
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
  // A locked cell is on whatever the member chose.
  const [on, setOn] = useChecked(() =>
    rows.flatMap((r) =>
      r.cells.filter((c) => c.enabled || c.locked).map((c) => `${r.category}.${c.channel}`),
    ),
  );
  const summary = useSummary();
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
        <Accordion
          keepMounted
          items={rows.map((row) => {
            const label = t(`categories.${row.category}.label`);
            return {
              title: label,
              meta: summary(row.category, on),
              content: (
                <CategoryChoices category={row.category} urgent={row.urgent}>
                  {row.cells.map((cell) => {
                    const key = MATRIX_CHANNELS.find((c) => c.channel === cell.channel)?.key ?? "";
                    const channel = t(`channels.${key}`);
                    const name = t("cellLabel", { category: label, channel });
                    return cell.locked ? (
                      <Cell
                        key={cell.channel}
                        name={`locked.${row.category}.${cell.channel}`}
                        label={`${name}. ${t("mine.locked")}`}
                        channel={channel}
                        note={t("mine.locked")}
                        checked
                        disabled
                      />
                    ) : (
                      <Cell
                        key={cell.channel}
                        name={`cell.${row.category}.${cell.channel}`}
                        label={name}
                        channel={channel}
                        checked={on.has(`${row.category}.${cell.channel}`)}
                        onChange={(checked) => setOn(`${row.category}.${cell.channel}`, checked)}
                      />
                    );
                  })}
                </CategoryChoices>
              ),
            };
          })}
        />
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
  const [on, setOn] = useChecked(() =>
    rows.flatMap((r) => r.cells.filter((c) => c.enabled).map((c) => `${r.category}.${c.channel}`)),
  );
  const [mandatory, setMandatory] = useChecked(() =>
    rows.filter((r) => r.mandatory).map((r) => r.category),
  );
  const summary = useSummary();
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
        <Accordion
          keepMounted
          items={rows.map((row) => {
            const label = t(`categories.${row.category}.label`);
            const channels = summary(row.category, on);
            return {
              title: label,
              meta: mandatory.has(row.category)
                ? t("org.summaryMandatory", { channels })
                : channels,
              content: (
                <CategoryChoices category={row.category} urgent={row.urgent}>
                  {row.cells.map((cell) => {
                    const key = MATRIX_CHANNELS.find((c) => c.channel === cell.channel)?.key ?? "";
                    const channel = t(`channels.${key}`);
                    return (
                      <Cell
                        key={cell.channel}
                        name={`default.${row.category}.${cell.channel}`}
                        label={t("cellLabel", { category: label, channel })}
                        channel={channel}
                        checked={on.has(`${row.category}.${cell.channel}`)}
                        onChange={(checked) => setOn(`${row.category}.${cell.channel}`, checked)}
                        disabled={!canEdit}
                      />
                    );
                  })}
                  <Cell
                    name="mandatory"
                    value={row.category}
                    label={t("org.mandatoryLabel", { category: label })}
                    channel={t("org.mandatory")}
                    checked={mandatory.has(row.category)}
                    onChange={(checked) => setMandatory(row.category, checked)}
                    disabled={!canEdit}
                  />
                </CategoryChoices>
              ),
            };
          })}
        />
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
