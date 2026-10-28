import type { Row } from "@xos/sync";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import { useMirror, useQueuedWrite } from "../../src/screens/settings/hooks";
import { OfflineNotice, WriteNotice } from "../../src/screens/settings/parts";
import {
  changedColumns,
  checkFullName,
  checkNameParts,
  type FieldErrors,
} from "../../src/settings/forms";
import { readMyPerson } from "../../src/settings/reads";
import { MIRROR, personUpdate } from "../../src/settings/writes";
import { Button, Card, ListRow, Screen, Skeleton, Tag, Text, TextField } from "../../src/ui";

const text = (row: Row, column: string): string => {
  const value = row[column];
  return typeof value === "string" ? value : "";
};

/**
 * The person's name (app.people): the full name as they write it, and the optional given and family names used for
 * formal address and sorting (Section 15, 1340). One save queues one update of the three columns that changed.
 */
function NameForm({ row }: { readonly row: Row }): ReactElement {
  const { t } = useTranslation();
  const write = useQueuedWrite();
  const [fullName, setFullName] = useState(text(row, "full_name"));
  const [givenName, setGivenName] = useState(text(row, "given_name"));
  const [familyName, setFamilyName] = useState(text(row, "family_name"));
  const [errors, setErrors] = useState<FieldErrors>({});
  const error = (field: string) => (errors[field] ? { error: t(errors[field]) } : {});
  const save = () => {
    const name = checkFullName(fullName);
    const parts = checkNameParts(givenName, familyName);
    if (!name.ok || !parts.ok) {
      setErrors({ ...(name.ok ? {} : name.errors), ...(parts.ok ? {} : parts.errors) });
      return;
    }
    setErrors({});
    const changes = changedColumns(row, { ...name.value, ...parts.value });
    if (Object.keys(changes).length === 0) write.unchanged();
    else void write.save(personUpdate(row, changes));
  };
  return (
    <Card testID="settings-account-name" title={t("compassSettings.account.nameTitle")}>
      <TextField
        testID="settings-account-full-name"
        label={t("gateway.settings.account.name")}
        help={t("compassSettings.account.fullNameHelp")}
        autoComplete="name"
        value={fullName}
        onChangeText={setFullName}
        {...error("fullName")}
      />
      <Text variant="text13" tone="tertiary">
        {t("workDetails.names.description")}
      </Text>
      <TextField
        testID="settings-account-given-name"
        label={t("workDetails.names.given")}
        value={givenName}
        onChangeText={setGivenName}
        {...error("givenName")}
      />
      <TextField
        testID="settings-account-family-name"
        label={t("workDetails.names.family")}
        value={familyName}
        onChangeText={setFamilyName}
        {...error("familyName")}
      />
      <Button
        testID="settings-account-save"
        block
        loading={write.state.kind === "sending"}
        label={t("compassSettings.account.saveName")}
        onPress={save}
      />
      <WriteNotice state={write.state} testID="settings-account" />
    </Card>
  );
}

/** A sign-in provider as the person knows it. */
function providerKey(provider: string): string {
  return ["email", "google", "apple", "phone"].includes(provider)
    ? `compassSettings.account.providers.${provider}`
    : "compassSettings.account.providers.other";
}

interface SignIn {
  readonly email: string | null;
  readonly providers: readonly string[];
}

/** The sign-in email and the ways the person signs in, from the session on the phone (works offline). */
function useSignIn(): SignIn | null {
  const { client } = useCompass();
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  useEffect(() => {
    let live = true;
    void client.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      if (!live || !user) return;
      const providers = [
        ...new Set((user.identities ?? []).map((i) => i.provider).filter(Boolean)),
      ];
      setSignIn({ email: user.email ?? null, providers });
    });
    return () => {
      live = false;
    };
  }, [client]);
  return signIn;
}

/**
 * Settings, Account (sitemap settings.account; Section 4.5.6 item 3): the person's name, which saves on the phone
 * offline (ADR 0070), the sign-in email and the ways they sign in, and Delete Account (SIM-004, journey 38), which
 * opens the deletion screen and needs a connection.
 */
export default function AccountScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { client, network, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const read = useCallback(
    () => (personId ? readMyPerson(client, personId) : Promise.resolve(null)),
    [client, personId],
  );
  const person = useMirror<Row>(MIRROR.person, personId ? read : null);
  const row = person.rows.find((r) => r.id === personId);
  const signIn = useSignIn();
  return (
    <Screen
      testID="settings-account"
      title={t("nav.settings.personal.account")}
      keyboardShouldPersistTaps="handled"
    >
      <Text tone="secondary">{t("gateway.settings.leads.account")}</Text>
      {!network.isConnected && row ? <OfflineNotice kind="queues" /> : null}
      {row ? (
        <NameForm key={row.id} row={row} />
      ) : person.notLoaded ? (
        <OfflineNotice kind="first" />
      ) : (
        <Skeleton testID="settings-account-loading" lines={3} />
      )}
      <Card testID="settings-account-sign-in" title={t("compassSettings.account.signInTitle")}>
        <ListRow
          testID="settings-account-email"
          icon="key-round"
          title={signIn?.email ?? ""}
          subtitle={t("compassSettings.account.email")}
        />
        {(signIn?.providers ?? []).map((provider) => (
          <ListRow
            key={provider}
            testID="settings-account-provider"
            icon="link"
            title={t(providerKey(provider), { provider })}
            trailing={<Tag tone="success" label={t("compassSettings.account.linked")} />}
          />
        ))}
        <Text variant="text13" tone="tertiary">
          {t("gateway.settings.account.oneAccount")}
        </Text>
      </Card>
      <Card testID="settings-account-delete" title={t("compass.account.title")}>
        <ListRow
          testID="settings-account-delete-open"
          icon="ban"
          title={t("compass.settings.deleteAccount")}
          subtitle={t("compass.settings.deleteAccountHelp")}
          onPress={() => router.push("/settings/delete-account")}
        />
      </Card>
    </Screen>
  );
}
