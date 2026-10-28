"use client";

import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";
import {
  saveMyNotificationsAction,
  saveOrgNotificationDefaultsAction,
  type NotificationFormState,
} from "@/app/[org]/settings/notification-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { MATRIX_CHANNELS } from "@/lib/settings/notification-matrix";
import { ChoiceDisclosure } from "./choice-disclosure";

/**
 * The notification matrix forms (Section 4.5.6): a member's categories by channel with quiet hours and
 * digest (Personal settings, Notifications), and the org's defaults with mandatory categories
 * (Settings, Notifications). Each page has one form and its one primary action. Each category is a
 * closed group naming the channels it is on for, opened to change them: fifteen categories by four
 * channels would put 60 boxes on the page, past gate 27's seven fields (Section 18). A group offers only
 * the channels its category's kinds reach (A104).
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

/** The catalog key of a channel's label. */
const channelKey = (channel: string) =>
  MATRIX_CHANNELS.find((c) => c.channel === channel)?.key ?? "";

/** The channels a category is on for, as a list in the reader's language, or that it is on for none. */
function useChannelSummary() {
  const t = useCopy();
  const format = useFormatter();
  return (channels: readonly string[]) =>
    channels.length === 0
      ? t("noChannels")
      : format.list(
          channels.map((c) => t(`channels.${channelKey(c)}`)),
          { type: "unit", style: "short" },
        );
}

/** Which boxes are checked, keyed `{category}.{channel}`, kept as they change for the summaries. */
function useChecked(initial: () => Iterable<string>) {
  const [checked, setChecked] = useState(() => new Set(initial()));
  const set = (key: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return [checked, set] as const;
}

/** One category: its label and the channels it is on for, opened to its help and its boxes. */
function CategoryGroup({
  category,
  urgent,
  summary,
  note,
  children,
}: {
  category: string;
  urgent: boolean;
  summary: string;
  /** Shown under the boxes, for example that the organization requires some of them. */
  note?: string | undefined;
  children: ReactNode;
}) {
  const t = useCopy();
  const label = t(`categories.${category}.label`);
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <ChoiceDisclosure title={label} summary={summary}>
        <p className="m-0 text-text-13 text-text-secondary">
          {t(`categories.${category}.help`)}
          {urgent ? ` ${t("urgent")}` : ""}
        </p>
        <div className="flex flex-wrap gap-x-16 gap-y-8">{children}</div>
        {note ? <p className="m-0 text-text-12 text-text-secondary">{note}</p> : null}
      </ChoiceDisclosure>
    </fieldset>
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
  const summary = useChannelSummary();
  const [checked, setChecked] = useChecked(() =>
    rows.flatMap((row) =>
      row.cells
        .filter((cell) => cell.enabled || cell.locked)
        .map((cell) => `${row.category}.${cell.channel}`),
    ),
  );
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
        <div className="flex flex-col gap-8">
          {rows.map((row) => {
            const category = t(`categories.${row.category}.label`);
            const locked = row.cells.some((cell) => cell.locked);
            return (
              <CategoryGroup
                key={row.category}
                category={row.category}
                urgent={row.urgent}
                summary={summary(
                  row.cells
                    .filter((cell) => checked.has(`${row.category}.${cell.channel}`))
                    .map((cell) => cell.channel),
                )}
                note={locked ? t("mine.locked") : undefined}
              >
                {row.cells.map((cell) => {
                  const channel = t(`channels.${channelKey(cell.channel)}`);
                  const label = t("cellLabel", { category, channel });
                  return cell.locked ? (
                    <Checkbox
                      key={cell.channel}
                      name={`locked.${row.category}.${cell.channel}`}
                      label={channel}
                      aria-label={`${label}. ${t("mine.locked")}`}
                      title={t("mine.locked")}
                      defaultChecked
                      disabled
                    />
                  ) : (
                    <Checkbox
                      key={cell.channel}
                      name={`cell.${row.category}.${cell.channel}`}
                      label={channel}
                      aria-label={label}
                      defaultChecked={cell.enabled}
                      onChange={(e) =>
                        setChecked(`${row.category}.${cell.channel}`, e.currentTarget.checked)
                      }
                    />
                  );
                })}
              </CategoryGroup>
            );
          })}
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

/** Settings, Notifications: the org's default matrix with a mandatory box per category. */
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
  const summary = useChannelSummary();
  // Checked channels keyed `{category}.{channel}`, and mandatory categories by their code.
  const [checked, setChecked] = useChecked(() =>
    rows.flatMap((row) => [
      ...row.cells.filter((cell) => cell.enabled).map((cell) => `${row.category}.${cell.channel}`),
      ...(row.mandatory ? [row.category] : []),
    ]),
  );
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
        <div className="flex flex-col gap-8">
          {rows.map((row) => {
            const category = t(`categories.${row.category}.label`);
            const channels = summary(
              row.cells
                .filter((cell) => checked.has(`${row.category}.${cell.channel}`))
                .map((cell) => cell.channel),
            );
            return (
              <CategoryGroup
                key={row.category}
                category={row.category}
                urgent={row.urgent}
                summary={
                  checked.has(row.category) ? `${channels} · ${t("org.mandatory")}` : channels
                }
              >
                {row.cells.map((cell) => {
                  const channel = t(`channels.${channelKey(cell.channel)}`);
                  return (
                    <Checkbox
                      key={cell.channel}
                      name={`default.${row.category}.${cell.channel}`}
                      label={channel}
                      aria-label={t("cellLabel", { category, channel })}
                      defaultChecked={cell.enabled}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setChecked(`${row.category}.${cell.channel}`, e.currentTarget.checked)
                      }
                    />
                  );
                })}
                <Checkbox
                  name="mandatory"
                  value={row.category}
                  label={t("org.mandatory")}
                  aria-label={t("org.mandatoryLabel", { category })}
                  defaultChecked={row.mandatory}
                  disabled={!canEdit}
                  onChange={(e) => setChecked(row.category, e.currentTarget.checked)}
                />
              </CategoryGroup>
            );
          })}
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
