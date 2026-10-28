import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import { useMirror, useQueuedWrite } from "../../src/screens/settings/hooks";
import { LabeledChoice, OfflineNotice, WriteNotice } from "../../src/screens/settings/parts";
import { ProfileLists, profileRuleKey } from "../../src/screens/settings/ProfileLists";
import {
  changedColumns,
  checkProfileFacts,
  RATE_UNITS,
  rateText,
  type FieldErrors,
  type ProfileFactsInput,
} from "../../src/settings/forms";
import { readMyProfile } from "../../src/settings/reads";
import { gatewaySectionUrl } from "../../src/settings/sections";
import { MIRROR, profileUpdate } from "../../src/settings/writes";
import { Button, Card, ErrorState, ListRow, Screen, Skeleton, Text, TextField } from "../../src/ui";

const text = (row: Row, column: string): string => {
  const value = row[column];
  return typeof value === "string" ? value : "";
};

function factsOf(row: Row): ProfileFactsInput {
  const currency = text(row, "rate_currency");
  return {
    handle: text(row, "handle"),
    preferredName: text(row, "preferred_name"),
    pronouns: text(row, "pronouns"),
    headline: text(row, "headline"),
    bio: text(row, "bio"),
    city: text(row, "city"),
    countryCode: text(row, "country_code"),
    rate: rateText(row["rate_minor"] as number | null | undefined, currency || "USD"),
    rateCurrency: currency || "USD",
    rateUnit: text(row, "rate_unit") || "Day",
  };
}

/**
 * The profile facts (Section 4.8.2), as Gateway's and Atlas's profile forms edit them: handle, preferred name,
 * pronouns, headline, bio, city, country and published rate. Saving queues an update of app.person_profiles with
 * the columns that changed; offline it saves on the phone and uploads on reconnect.
 */
function FactsForm({ row }: { readonly row: Row }): ReactElement {
  const { t } = useTranslation();
  const { config } = useCompass();
  const write = useQueuedWrite();
  const [facts, setFacts] = useState<ProfileFactsInput>(() => factsOf(row));
  const [errors, setErrors] = useState<FieldErrors>({});
  const field = (name: keyof ProfileFactsInput) => ({
    value: facts[name],
    onChangeText: (value: string) => setFacts((current) => ({ ...current, [name]: value })),
    ...(errors[name] ? { error: t(errors[name]) } : {}),
  });
  const save = () => {
    const checked = checkProfileFacts(facts);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const changes = changedColumns(row, checked.value);
    if (Object.keys(changes).length === 0) write.unchanged();
    else void write.save(profileUpdate(row, changes));
  };
  const profileUrl = gatewaySectionUrl(config.gatewayUrl, `/u/${text(row, "handle")}`);
  return (
    <>
      <Card testID="settings-profile-facts" title={t("compassSettings.profile.facts")}>
        <TextField
          testID="settings-profile-handle"
          label={t("profiles.fields.handle")}
          help={t("profiles.fields.handleHelp", { url: profileUrl })}
          autoComplete="off"
          {...field("handle")}
        />
        <TextField
          testID="settings-profile-preferred-name"
          label={t("profiles.fields.preferredName")}
          help={t("profiles.fields.optional")}
          autoComplete="name"
          {...field("preferredName")}
        />
        <TextField
          testID="settings-profile-pronouns"
          label={t("profiles.fields.pronouns")}
          help={t("profiles.fields.optional")}
          {...field("pronouns")}
        />
        <TextField
          testID="settings-profile-headline"
          label={t("profiles.fields.headline")}
          help={t("profiles.fields.headlineHelp")}
          {...field("headline")}
        />
        <TextField
          testID="settings-profile-bio"
          label={t("profiles.fields.bio")}
          multiline
          {...field("bio")}
        />
        <TextField
          testID="settings-profile-city"
          label={t("profiles.fields.city")}
          help={t("profiles.fields.cityHelp")}
          {...field("city")}
        />
        <TextField
          testID="settings-profile-country"
          label={t("profiles.fields.country")}
          help={t("profiles.fields.countryHelp")}
          autoComplete="off"
          {...field("countryCode")}
        />
        <TextField
          testID="settings-profile-rate"
          label={t("profiles.fields.rate")}
          help={t("profiles.fields.rateHelp")}
          keyboard="decimal"
          {...field("rate")}
        />
        <TextField
          testID="settings-profile-rate-currency"
          label={t("profiles.fields.rateCurrency")}
          help={t("compassSettings.profile.currencyHelp")}
          autoComplete="off"
          {...field("rateCurrency")}
        />
        <LabeledChoice
          testID="settings-profile-rate-unit"
          label={t("profiles.fields.rateUnit")}
          value={facts.rateUnit}
          options={RATE_UNITS.map((u) => ({ value: u, label: t(`profiles.rateUnits.${u}`) }))}
          onChange={(rateUnit) => setFacts((current) => ({ ...current, rateUnit }))}
        />
        <Button
          testID="settings-profile-save"
          block
          loading={write.state.kind === "sending"}
          label={t("profiles.saveProfile")}
          onPress={save}
        />
        <WriteNotice state={write.state} ruleKey={profileRuleKey} testID="settings-profile" />
      </Card>
      <Card>
        <ListRow
          testID="settings-profile-public"
          icon="external-link"
          title={t("compassSettings.profile.publicProfile")}
          subtitle={profileUrl}
          onPress={() => void Linking.openURL(profileUrl)}
        />
      </Card>
    </>
  );
}

/**
 * Settings, Profile (sitemap settings.profile; Section 4.5.6 item 1): what organizations see when the person applies
 * or shares their profile. The facts and the lists are the person's own rows, kept on the phone, so the section
 * opens and saves offline once it has been opened online (ADR 0070). The name is under Account, as in Gateway.
 */
export default function ProfileSettingsScreen(): ReactElement {
  const { t } = useTranslation();
  const { client, network, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const read = useCallback(() => readMyProfile(client), [client]);
  const profile = useMirror<Row>(MIRROR.profile, personId ? read : null);
  const row = profile.rows[0];
  return (
    <Screen
      testID="settings-profile"
      title={t("nav.settings.personal.profile")}
      keyboardShouldPersistTaps="handled"
    >
      <Text tone="secondary">{t("gateway.settings.leads.profile")}</Text>
      {!network.isConnected && row ? <OfflineNotice kind="queues" /> : null}
      {row ? (
        <FactsForm key={row.id} row={row} />
      ) : profile.notLoaded ? (
        <OfflineNotice kind="first" />
      ) : profile.failed ? (
        <ErrorState
          testID="settings-profile-error"
          title={t("compass.states.errorTitle")}
          sentence={t("compassSettings.common.loadFailed")}
          actionLabel={t("compass.common.retry")}
          onRetry={profile.reload}
        />
      ) : (
        <Skeleton testID="settings-profile-loading" lines={6} />
      )}
      {personId && row ? <ProfileLists personId={personId} /> : null}
    </Screen>
  );
}
