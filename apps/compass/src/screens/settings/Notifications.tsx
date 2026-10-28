/**
 * Settings, Notifications in Compass (Section 4.5.6 personal settings item 8, Section 4.3 item 15 part 3, A111,
 * ADR 0071). A member sees, for the org they pick, the matrix of Atlas Me with that org's locks, quiet hours read in
 * a time zone, the email digest and consent to texts. Everyone sees the party categories and their own quiet hours,
 * as Gateway shows them. Each category offers only the channels its kinds reach. Everything but consent to texts
 * saves on the phone at once and sends when the phone is online.
 */
import type { XosClient } from "@xos/data";
import { getAccountNotificationDefaults } from "@xos/data/company-settings";
import {
  DIGEST_FREQUENCIES,
  getMyNotificationMatrix,
  getMyNotificationSettings,
  getMyNotificationTimeZone,
  getMySmsStatus,
  recordMySmsConsent,
  type DigestFrequency,
} from "@xos/data/notification-settings";
import { getMyQuietHours, listMyNotificationPreferences } from "@xos/data/party-notifications";
import type { Row } from "@xos/sync";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../runtime/CompassProvider";
import {
  CHANNEL_KEYS,
  channelWrite,
  checkQuietHours,
  isDigest,
  matrixRows,
  matrixView,
  NOTIFICATION_MIRROR,
  orgSettingsOf,
  orgSettingsRow,
  orgSettingsWrite,
  partyRows,
  partyView,
  partyWrite,
  QUIET_HOURS_ROW,
  quietHoursOf,
  quietHoursRow,
  quietHoursWrite,
  withSmsConsent,
  type QuietHours,
  type QuietHoursInput,
  type QuietHoursProblem,
} from "../../settings/notifications";
import type { WriteState } from "../../settings/writes";
import { zoneLabel } from "../../settings/zones";
import { Button, Card, InlineAlert, Screen, Switch, Text, TextField, useTheme } from "../../ui";
import { ChoiceRow, ChoiceSheet, ZoneSheet } from "./ChoiceSheet";
import { useMirror, useQueuedWrite } from "./hooks";
import { LabeledChoice, OfflineNotice, WriteNotice } from "./parts";

const N = "settings.notifications";
const P = "compassPersonal.notifications";

/** Refusals of the 1362 RPCs with their own sentence under `settings.notifications.errors`. */
const NOTIFICATION_RULES: ReadonlySet<string> = new Set([
  "notification_category_mandatory",
  "time_zone_unknown",
]);
const ruleKey = (rule: string) =>
  NOTIFICATION_RULES.has(rule) ? `${N}.errors.${rule}` : undefined;

const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** Quiet hours with a zone, and for a member's org the digest, in one form with one save. */
function QuietHoursCard({
  title,
  description,
  initial,
  digest,
  state,
  onSave,
  testID,
}: {
  readonly title: string;
  readonly description: string;
  readonly initial: QuietHours;
  readonly digest?: { readonly frequency: DigestFrequency; readonly hour: number };
  readonly state: WriteState;
  readonly onSave: (
    quiet: QuietHours,
    digest?: { readonly frequency: DigestFrequency; readonly hour: number },
  ) => void;
  readonly testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const { personZone } = useCompass();
  const [form, setForm] = useState<QuietHoursInput>({
    start: initial.start ?? "",
    end: initial.end ?? "",
    timeZone: initial.timeZone,
  });
  const [frequency, setFrequency] = useState<DigestFrequency>(digest?.frequency ?? "Off");
  const [hour, setHour] = useState(digest?.hour ?? 8);
  const [errors, setErrors] = useState<Partial<Record<keyof QuietHoursInput, QuietHoursProblem>>>(
    {},
  );
  const [sheet, setSheet] = useState<"zone" | "hour" | null>(null);
  const error = (field: keyof QuietHoursInput) => {
    const problem = errors[field];
    return problem ? { error: t(`${P}.errors.${problem}`) } : {};
  };
  const save = () => {
    const checked = checkQuietHours(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setForm({
      start: checked.value.start ?? "",
      end: checked.value.end ?? "",
      timeZone: checked.value.timeZone,
    });
    if (digest && isDigest(frequency, hour)) onSave(checked.value, { frequency, hour });
    else onSave(checked.value);
  };
  return (
    <Card title={title} testID={testID}>
      <Text variant="text13" tone="secondary">
        {description}
      </Text>
      <TextField
        testID={`${testID}-start`}
        label={t(`${N}.mine.quietStart`)}
        help={t(`${P}.timeHelp`)}
        value={form.start}
        onChangeText={(start) => setForm((f) => ({ ...f, start }))}
        autoComplete="off"
        {...error("start")}
      />
      <TextField
        testID={`${testID}-end`}
        label={t(`${N}.mine.quietEnd`)}
        value={form.end}
        onChangeText={(end) => setForm((f) => ({ ...f, end }))}
        autoComplete="off"
        {...error("end")}
      />
      <ChoiceRow
        testID={`${testID}-zone`}
        title={t(`${N}.mine.timeZone`)}
        value={form.timeZone ? zoneLabel(form.timeZone) : t("workDetails.notSet")}
        onPress={() => setSheet("zone")}
      />
      {errors.timeZone ? (
        <Text variant="text13" tone="danger">
          {t(`${P}.errors.${errors.timeZone}`)}
        </Text>
      ) : null}
      <ZoneSheet
        testID={`${testID}-zone-sheet`}
        open={sheet === "zone"}
        title={t(`${N}.mine.timeZone`)}
        value={form.timeZone}
        deviceZone={personZone}
        onChoose={(timeZone) => setForm((f) => ({ ...f, timeZone }))}
        onClose={() => setSheet(null)}
      />
      {digest ? (
        <>
          <LabeledChoice
            testID={`${testID}-digest`}
            label={t(`${N}.mine.digest`)}
            value={frequency}
            options={DIGEST_FREQUENCIES.map((f) => ({ value: f, label: t(`${N}.digest.${f}`) }))}
            onChange={(f) => setFrequency(DIGEST_FREQUENCIES.find((d) => d === f) ?? "Off")}
          />
          <Text variant="text13" tone="tertiary">
            {t(`${N}.mine.digestHelp`)}
          </Text>
          <ChoiceRow
            testID={`${testID}-digest-hour`}
            title={t(`${N}.mine.digestHour`)}
            value={hourLabel(hour)}
            onPress={() => setSheet("hour")}
          />
          <ChoiceSheet
            testID={`${testID}-digest-hour-sheet`}
            open={sheet === "hour"}
            title={t(`${N}.mine.digestHour`)}
            value={String(hour)}
            choices={Array.from({ length: 24 }, (_, h) => ({
              value: String(h),
              label: hourLabel(h),
            }))}
            onChoose={(h) => setHour(Number(h))}
            onClose={() => setSheet(null)}
          />
        </>
      ) : null}
      <Button
        testID={`${testID}-save`}
        label={t("compass.common.save")}
        variant="primary"
        block
        onPress={save}
      />
      <WriteNotice testID={`${testID}-write`} state={state} ruleKey={ruleKey} />
    </Card>
  );
}

/** Consent to texts in one org: recorded online only, when the person reads the wording (TCPA, Section 14.5). */
function TextsCard({ orgId, row }: { readonly orgId: string; readonly row: Row }): ReactElement {
  const { t } = useTranslation();
  const { client, store, network } = useCompass();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = orgSettingsOf(row);
  const online = network.isConnected;
  const record = async (consent: boolean) => {
    setBusy(true);
    setError(null);
    const result = await recordMySmsConsent(client as unknown as XosClient, orgId, consent);
    setBusy(false);
    if (!result.ok) {
      const rule = result.error.kind === "refusal" ? result.error.rule : "";
      setError(
        t(
          rule === "sms_phone_unverified"
            ? `${N}.errors.sms_phone_unverified`
            : `${N}.errors.unexpected`,
        ),
      );
      return;
    }
    await store?.transaction((tx) => {
      const current = tx.get(NOTIFICATION_MIRROR.orgSettings, orgId);
      if (current) tx.put(NOTIFICATION_MIRROR.orgSettings, withSmsConsent(current, consent));
    });
  };
  return (
    <Card title={t(`${P}.textsTitle`)} testID="notify-texts">
      <Text variant="text13" tone="secondary">
        {t(`${N}.mine.smsNote`)}
      </Text>
      {settings?.phoneLast4 ? (
        <Switch
          testID="notify-texts-consent"
          label={t(`${N}.mine.smsConsent`, { phone: `•••${settings.phoneLast4}` })}
          value={settings.mayText}
          disabled={!online || busy}
          onChange={(consent) => void record(consent)}
        />
      ) : (
        <Text tone="secondary">{t(`${N}.mine.smsNoPhone`)}</Text>
      )}
      {online ? null : <OfflineNotice kind="needs" testID="notify-texts-offline" />}
      {error ? <InlineAlert testID="notify-texts-error" tone="danger" message={error} /> : null}
    </Card>
  );
}

export function NotificationsSettings(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, resolved, network, personZone } = useCompass();
  const db = client as unknown as XosClient;
  const personId = resolved?.identity.personId ?? null;
  const members = useMemo(
    () => (resolved?.contexts ?? []).filter((c) => c.kind === "member"),
    [resolved?.contexts],
  );
  const memberKey = members.map((c) => c.orgId).join(",");
  const [picked, setPicked] = useState<string | null>(null);
  const orgId =
    members.find((c) => c.orgId === picked)?.orgId ??
    members.find((c) => c.orgId === resolved?.orgId)?.orgId ??
    members[0]?.orgId ??
    null;

  const readMatrix = useCallback(async (): Promise<Row[] | null> => {
    const rows: Row[] = [];
    for (const id of memberKey.split(",").filter(Boolean)) {
      const read = await getMyNotificationMatrix(db, id);
      if (!read.ok) return null;
      rows.push(...matrixRows(id, read.data));
    }
    return rows;
  }, [db, memberKey]);
  const readOrgSettings = useCallback(async (): Promise<Row[] | null> => {
    const ids = memberKey.split(",").filter(Boolean);
    const rows = await Promise.all(
      ids.map(async (id) => {
        const [saved, sms, zone] = await Promise.all([
          getMyNotificationSettings(db, id),
          getMySmsStatus(db, id),
          getMyNotificationTimeZone(db, id),
        ]);
        return saved.ok && sms.ok && zone.ok
          ? orgSettingsRow(id, saved.data, zone.data, personZone, sms.data)
          : null;
      }),
    );
    return rows.every((r) => r !== null) ? rows : null;
  }, [db, memberKey, personZone]);
  const readParty = useCallback(async (): Promise<Row[] | null> => {
    const company = await getAccountNotificationDefaults(db);
    const prefs = await listMyNotificationPreferences(db, company.ok ? company.data : []);
    return prefs.ok ? partyRows(prefs.data) : null;
  }, [db]);
  const readQuiet = useCallback(async (): Promise<Row[] | null> => {
    const quiet = await getMyQuietHours(db);
    return quiet.ok ? [quietHoursRow(quiet.data, personZone)] : null;
  }, [db, personZone]);

  const hasMembership = memberKey !== "";
  const matrix = useMirror(NOTIFICATION_MIRROR.matrix, hasMembership ? readMatrix : null);
  const orgSettings = useMirror(
    NOTIFICATION_MIRROR.orgSettings,
    hasMembership ? readOrgSettings : null,
  );
  const party = useMirror(NOTIFICATION_MIRROR.party, readParty);
  const quiet = useMirror(NOTIFICATION_MIRROR.quietHours, readQuiet);
  const matrixWrite = useQueuedWrite();
  const orgWrite = useQueuedWrite();
  const partyWriteState = useQueuedWrite();
  const quietWrite = useQueuedWrite();

  const online = network.isConnected;
  const notLoaded = party.notLoaded && quiet.notLoaded && (!hasMembership || matrix.notLoaded);
  const failed = matrix.failed || orgSettings.failed || party.failed || quiet.failed;
  const reload = () => {
    matrix.reload();
    orgSettings.reload();
    party.reload();
    quiet.reload();
  };
  const orgRow = orgId ? orgSettings.rows.find((r) => r.id === orgId) : undefined;
  const orgValues = orgSettingsOf(orgRow);
  const quietRow = quiet.rows.find((r) => r.id === QUIET_HOURS_ROW);
  const own = quietHoursOf(quietRow, personZone);

  return (
    <Screen
      testID="settings-notifications"
      title={t("nav.settings.personal.notifications")}
      refreshing={false}
      onRefresh={reload}
      keyboardShouldPersistTaps="handled"
    >
      {online ? null : <OfflineNotice kind={notLoaded ? "first" : "queues"} />}
      {failed ? (
        <InlineAlert
          testID="settings-notifications-failed"
          tone="danger"
          message={t("compassPersonal.loadFailed")}
        />
      ) : null}
      {notLoaded ? null : (
        <>
          {orgId ? (
            <View style={{ gap: theme.space["16"] }}>
              <Text variant="heading20" heading>
                {t(`${P}.orgsTitle`)}
              </Text>
              <Text tone="secondary">{t(`${P}.orgsHelp`)}</Text>
              {members.length > 1 ? (
                <LabeledChoice
                  testID="notify-org"
                  label={t(`${P}.org`)}
                  value={orgId}
                  options={members.map((c) => ({ value: c.orgId, label: c.orgName }))}
                  onChange={setPicked}
                />
              ) : (
                <Text variant="heading16">{members[0]?.orgName ?? ""}</Text>
              )}
              <Text tone="secondary">{t(`${N}.mine.matrixDescription`)}</Text>
              {matrixView(matrix.rows, orgId).map((category) => (
                <Card
                  key={category.category}
                  title={t(`${N}.categories.${category.category}.label`)}
                  testID={`notify-${category.category}`}
                >
                  <Text variant="text13" tone="secondary">
                    {category.urgent
                      ? `${t(`${N}.categories.${category.category}.help`)} ${t(`${N}.urgent`)}`
                      : t(`${N}.categories.${category.category}.help`)}
                  </Text>
                  {category.cells.map((cell) => (
                    <Switch
                      key={cell.channel}
                      testID={`notify-${category.category}-${CHANNEL_KEYS[cell.channel]}`}
                      label={t(`${N}.channels.${CHANNEL_KEYS[cell.channel]}`)}
                      {...(cell.locked ? { help: t(`${N}.mine.locked`) } : {})}
                      value={cell.enabled}
                      disabled={cell.locked}
                      onChange={(enabled) => {
                        const row = matrix.rows.find((r) => r.id === cell.rowId);
                        const input = row ? channelWrite(row, enabled) : null;
                        if (input) void matrixWrite.save(input);
                      }}
                    />
                  ))}
                </Card>
              ))}
              <WriteNotice
                testID="notify-matrix-write"
                state={matrixWrite.state}
                ruleKey={ruleKey}
              />
              {orgRow && orgValues ? (
                <QuietHoursCard
                  key={[
                    orgId,
                    orgValues.timeZone,
                    orgValues.quietStart,
                    orgValues.quietEnd,
                    orgValues.digestFrequency,
                    orgValues.digestHour,
                  ].join(":")}
                  testID="notify-quiet"
                  title={t(`${N}.mine.quietTitle`)}
                  description={t(`${N}.mine.quietDescription`)}
                  initial={{
                    start: orgValues.quietStart,
                    end: orgValues.quietEnd,
                    timeZone: orgValues.timeZone,
                  }}
                  digest={{ frequency: orgValues.digestFrequency, hour: orgValues.digestHour }}
                  state={orgWrite.state}
                  onSave={(value, digest) =>
                    void orgWrite.save(
                      orgSettingsWrite(
                        orgRow,
                        value,
                        digest ?? {
                          frequency: orgValues.digestFrequency,
                          hour: orgValues.digestHour,
                        },
                      ),
                    )
                  }
                />
              ) : null}
              {orgRow ? <TextsCard orgId={orgId} row={orgRow} /> : null}
            </View>
          ) : null}
          <View style={{ gap: theme.space["16"] }}>
            <Text variant="heading20" heading>
              {t(`${P}.otherTitle`)}
            </Text>
            <Text tone="secondary">{t(`${P}.otherHelp`)}</Text>
            {partyView(party.rows).map((category) => (
              <Card
                key={category.category}
                title={t(`${N}.categories.${category.category}.label`)}
                testID={`notify-party-${category.category}`}
              >
                <Text variant="text13" tone="secondary">
                  {t(`${N}.categories.${category.category}.help`)}
                </Text>
                {category.cells.map((cell) => (
                  <Switch
                    key={cell.channel}
                    testID={`notify-party-${category.category}-${CHANNEL_KEYS[cell.channel]}`}
                    label={t(`${N}.channels.${CHANNEL_KEYS[cell.channel]}`)}
                    value={cell.enabled}
                    disabled={personId === null}
                    onChange={(enabled) => {
                      const row = party.rows.find((r) => r.id === cell.rowId);
                      const input = row && personId ? partyWrite(row, personId, enabled) : null;
                      if (input) void partyWriteState.save(input);
                    }}
                  />
                ))}
              </Card>
            ))}
            <WriteNotice testID="notify-party-write" state={partyWriteState.state} />
            {quietRow ? (
              <QuietHoursCard
                key={JSON.stringify(own)}
                testID="notify-own"
                title={t(`${P}.ownQuietTitle`)}
                description={t(`${P}.ownQuietHelp`)}
                initial={own}
                state={quietWrite.state}
                onSave={(value) => void quietWrite.save(quietHoursWrite(quietRow, value))}
              />
            ) : null}
          </View>
        </>
      )}
    </Screen>
  );
}
