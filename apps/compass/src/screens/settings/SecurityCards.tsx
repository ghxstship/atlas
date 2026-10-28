/**
 * The cards of Settings, Security (Section 4.5.6 item 4; A77, A99; ADR 0070): the password and second factors here,
 * and recovery codes, passkeys, and sessions and devices in ./SecuritySessions.tsx. Each call runs with the person's session and needs the server's answer,
 * so offline every control is disabled and the screen says so. Changes to how the person signs in step up first by
 * Gateway's rule (src/settings/security.ts).
 */
import {
  getRecoveryCodeStatus,
  listMySessions,
  pruneRecoveryCodes,
  type RecoveryCodeStatus,
  type SignedInSession,
} from "@xos/data/account-security";
import {
  listPasskeys,
  listSecondFactors,
  removeSecondFactor,
  renameSecondFactor,
  startTotpEnrollment,
  verifyTotp,
  type Passkey,
  type SecondFactor,
  type TotpEnrollment,
} from "@xos/data/auth-assurance";
import type { XosClient } from "@xos/data/client";
import type { Result } from "@xos/data/result";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../runtime/CompassProvider";
import {
  checkEmailCode,
  checkFactorLabel,
  checkNewPassword,
  checkTotpCode,
} from "../../settings/forms";
import { gatewaySectionUrl } from "../../settings/sections";
import {
  changePassword,
  isStepUpRefusal,
  securityErrorKey,
  sendPasswordCode,
  STEP_UP,
  type PasswordOutcome,
} from "../../settings/security";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Sheet,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from "../../ui";
import { ConfirmSheet, OfflineNotice } from "./parts";
import type { StepUp } from "./StepUp";

const A = "authSecurity";
const S = "compassSettings.security";

type Loaded<T> = T | null | "failed";

export interface SecurityData {
  readonly factors: Loaded<readonly SecondFactor[]>;
  readonly passkeys: Loaded<readonly Passkey[]>;
  readonly codes: Loaded<RecoveryCodeStatus>;
  readonly sessions: Loaded<readonly SignedInSession[]>;
  readonly reload: () => void;
}

const value = <T,>(result: Result<T>): T | "failed" => (result.ok ? result.data : "failed");

/** Everything Security shows, read together whenever the phone is online, and again after each change. */
export function useSecurityData(): SecurityData {
  const { client, network } = useCompass();
  const db = client as unknown as XosClient;
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<Omit<SecurityData, "reload">>({
    factors: null,
    passkeys: null,
    codes: null,
    sessions: null,
  });
  useEffect(() => {
    if (!network.isConnected) return undefined;
    let live = true;
    void Promise.all([
      listSecondFactors(db),
      listPasskeys(db),
      getRecoveryCodeStatus(db),
      listMySessions(db),
    ]).then(([factors, passkeys, codes, sessions]) => {
      if (!live) return;
      setData({
        factors: value(factors),
        passkeys: value(passkeys),
        codes: value(codes),
        sessions: value(sessions),
      });
    });
    return () => {
      live = false;
    };
  }, [db, network.isConnected, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...data, reload };
}

/** Whether the person holds a verified second factor, as far as the screen knows. */
export function holdsFactor(data: SecurityData): boolean {
  return Array.isArray(data.factors) && data.factors.some((f) => f.verified);
}

export function useDate(): { date: (iso: string) => string; dateTime: (iso: string) => string } {
  const { i18n } = useTranslation();
  const { personZone } = useCompass();
  return {
    date: (iso) =>
      new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(iso)),
    dateTime: (iso) =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: personZone,
      }).format(new Date(iso)),
  };
}

// Password ------------------------------------------------------------------------------------------------------------

const PASSWORD_MESSAGES: Readonly<
  Record<Exclude<PasswordOutcome, "ok" | "reauthenticate">, string>
> = {
  code_invalid: `${S}.errors.emailCode`,
  same_password: `${S}.errors.samePassword`,
  weak_password: `${S}.errors.weakPassword`,
  step_up_required: `${A}.errors.step_up_required`,
  rate_limited: `${A}.errors.rate_limited`,
  network: "compassSettings.common.offlineNeeds",
  unexpected: `${A}.errors.unexpected`,
};

/**
 * A new password on the sign-in Atlas, Gateway and Compass share. A session that signed in more than a day ago
 * confirms with a code Supabase Auth emails (secure_password_change); a person who holds a second factor steps up
 * first.
 */
export function PasswordCard({
  data,
  stepUp,
}: {
  readonly data: SecurityData;
  readonly stepUp: StepUp;
}): ReactElement {
  const { t } = useTranslation();
  const { client, network, resolved } = useCompass();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState<{
    tone: "success" | "danger" | "info";
    key: string;
  } | null>(null);
  useEffect(() => {
    void client.auth.getSession().then(({ data: session }) => {
      setEmail(session.session?.user.email ?? null);
    });
  }, [client]);

  const attempt = async (newPassword: string, nonce?: string): Promise<void> => {
    setBusy(true);
    const outcome = await changePassword(client, newPassword, nonce);
    if (outcome === "reauthenticate") {
      const sent = await sendPasswordCode(client);
      setBusy(false);
      if (sent === "ok") {
        setNeedsCode(true);
        setMessage({ tone: "info", key: `${S}.codeSent` });
      } else {
        setMessage({
          tone: "danger",
          key: PASSWORD_MESSAGES[sent === "reauthenticate" ? "unexpected" : sent],
        });
      }
      return;
    }
    setBusy(false);
    if (outcome === "step_up_required") {
      stepUp.require(() => attempt(newPassword, nonce));
      return;
    }
    if (outcome === "ok") {
      setPassword("");
      setConfirm("");
      setCode("");
      setNeedsCode(false);
      setMessage({ tone: "success", key: `${S}.passwordChanged` });
      return;
    }
    setMessage({ tone: "danger", key: PASSWORD_MESSAGES[outcome] });
  };

  const submit = () => {
    setMessage(null);
    const checked = checkNewPassword(password, confirm, {
      email,
      fullName: resolved?.identity.displayName ?? null,
    });
    const nonce = needsCode ? checkEmailCode(code) : null;
    if (!checked.ok || (nonce && !nonce.ok)) {
      setErrors({
        ...(checked.ok ? {} : checked.errors),
        ...(nonce && !nonce.ok ? nonce.errors : {}),
      });
      return;
    }
    setErrors({});
    const newPassword = checked.value.password;
    const emailed = nonce?.ok ? nonce.value.nonce : undefined;
    void stepUp.guard(STEP_UP["changePassword"] ?? "if-factor", holdsFactor(data), () =>
      attempt(newPassword, emailed),
    );
  };
  const offline = !network.isConnected;
  const error = (field: string) => (errors[field] ? { error: t(errors[field]) } : {});
  return (
    <Card testID="settings-security-password" title={t(`${S}.passwordTitle`)}>
      <Text variant="text13" tone="tertiary">
        {t(`${S}.passwordBody`)}
      </Text>
      <TextField
        testID="settings-security-password-new"
        label={t(`${S}.newPassword`)}
        help={t(`${S}.passwordHelp`)}
        secure
        autoComplete="password"
        value={password}
        onChangeText={setPassword}
        disabled={offline}
        {...error("password")}
      />
      <TextField
        testID="settings-security-password-confirm"
        label={t(`${S}.confirmPassword`)}
        secure
        autoComplete="password"
        value={confirm}
        onChangeText={setConfirm}
        disabled={offline}
        {...error("confirm")}
      />
      {needsCode ? (
        <>
          <TextField
            testID="settings-security-password-code"
            label={t(`${S}.emailCode`)}
            help={t(`${S}.emailCodeHelp`, { email: email ?? "" })}
            keyboard="numeric"
            autoComplete="one-time-code"
            value={code}
            onChangeText={setCode}
            disabled={offline}
            {...error("nonce")}
          />
          <Button
            testID="settings-security-password-resend"
            variant="ghost"
            label={t(`${S}.resendCode`)}
            disabled={offline || busy}
            onPress={() =>
              void sendPasswordCode(client).then((sent) =>
                setMessage(
                  sent === "ok"
                    ? { tone: "info", key: `${S}.codeSent` }
                    : {
                        tone: "danger",
                        key: PASSWORD_MESSAGES[sent === "reauthenticate" ? "unexpected" : sent],
                      },
                ),
              )
            }
          />
        </>
      ) : null}
      {message ? (
        <InlineAlert
          testID={`settings-security-password-${message.tone}`}
          tone={message.tone}
          message={t(message.key, { email: email ?? "" })}
        />
      ) : null}
      <Button
        testID="settings-security-password-save"
        block
        loading={busy}
        disabled={offline}
        label={t(`${S}.changePassword`)}
        onPress={submit}
      />
    </Card>
  );
}

// Second factors ----------------------------------------------------------------------------------------------------------

/** Rename a factor or passkey: one name field, 1 to 80 characters. */
export function RenameSheet({
  target,
  onClose,
  onSave,
}: {
  readonly target: { readonly name: string } | null;
  readonly onClose: () => void;
  readonly onSave: (label: string) => Promise<string | null>;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Starts from the current name each time the sheet opens for a factor or passkey.
  const targetName = target?.name ?? null;
  useEffect(() => {
    setLabel(targetName ?? "");
    setError(null);
  }, [targetName]);
  const save = async () => {
    const checked = checkFactorLabel(label);
    if (!checked.ok) {
      setError(t(Object.values(checked.errors)[0] ?? `${A}.errors.factor_label_length`));
      return;
    }
    setBusy(true);
    const failed = await onSave(checked.value.label);
    setBusy(false);
    if (failed) setError(t(failed));
    else onClose();
  };
  return (
    <Sheet
      testID="settings-security-rename"
      open={target !== null}
      title={t(`${A}.factors.renameLabel`, { name: target?.name ?? "" })}
      closeLabel={t("compass.common.close")}
      onClose={onClose}
    >
      <View style={{ gap: theme.space["16"] }}>
        <TextField
          testID="settings-security-rename-label"
          label={t(`${A}.enroll.label`)}
          value={label}
          onChangeText={setLabel}
          {...(error ? { error } : {})}
        />
        <Button
          testID="settings-security-rename-save"
          block
          loading={busy}
          label={t(`${A}.factors.save`)}
          onPress={() => void save()}
        />
      </View>
    </Sheet>
  );
}

/**
 * Setting up an authenticator app on the phone that runs it: the app opens from the otpauth link (or takes the
 * setup key), then the person enters the code it shows. An enrollment left unfinished is removed.
 */
function EnrollSheet({
  open,
  onClose,
  onDone,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client } = useCompass();
  const db = client as unknown as XosClient;
  const [label, setLabel] = useState("");
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setLabel(t(`${A}.enroll.totpDefault`));
    setEnrollment(null);
    setCode("");
    setError(null);
  }, [open, t]);

  const start = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const started = await startTotpEnrollment(db, name);
    setBusy(false);
    if (started.ok) {
      setEnrollment(started.data);
      return;
    }
    // The card steps up before this sheet opens (Supabase Auth asks for aal2 to add a second factor); a session
    // that lost it since is told so here, rather than stacking a second sheet on this one.
    setError(t(securityErrorKey(started.error)));
  };

  const verify = async () => {
    if (!enrollment) return;
    const checked = checkTotpCode(code);
    if (!checked.ok) {
      setError(t(Object.values(checked.errors)[0] ?? `${A}.errors.code_invalid`));
      return;
    }
    setBusy(true);
    const verified = await verifyTotp(db, enrollment.factorId, checked.value.code);
    setBusy(false);
    if (!verified.ok) {
      setError(t(securityErrorKey(verified.error)));
      return;
    }
    setEnrollment(null);
    onDone();
  };

  const cancel = () => {
    // An unfinished enrollment never counts; removing it lets the next one start under the same name.
    if (enrollment) {
      const pending = enrollment.factorId;
      void listSecondFactors(db).then((factors) => {
        if (factors.ok && factors.data.some((f) => f.id === pending && !f.verified)) {
          void removeSecondFactor(db, pending);
        }
      });
    }
    setEnrollment(null);
    onClose();
  };

  return (
    <Sheet
      testID="settings-security-enroll"
      open={open}
      title={t(`${A}.enroll.start`)}
      closeLabel={t("compass.common.close")}
      onClose={cancel}
    >
      <View style={{ gap: theme.space["16"] }}>
        {enrollment ? (
          <>
            <Text tone="secondary">{t(`${S}.enrollSentence`)}</Text>
            <Button
              testID="settings-security-enroll-open-app"
              variant="secondary"
              icon="external-link"
              block
              label={t(`${S}.openAuthenticator`)}
              onPress={() => void Linking.openURL(enrollment.uri).catch(() => undefined)}
            />
            <TextField
              testID="settings-security-enroll-secret"
              label={t(`${A}.enroll.secret`)}
              help={t(`${S}.setupKeyHelp`)}
              value={enrollment.secret}
              onChangeText={() => undefined}
              autoComplete="off"
            />
            <TextField
              testID="settings-security-enroll-code"
              label={t(`${S}.sixDigitCode`)}
              keyboard="numeric"
              autoComplete="one-time-code"
              value={code}
              onChangeText={setCode}
            />
            {error ? <InlineAlert tone="danger" message={error} /> : null}
            <Button
              testID="settings-security-enroll-verify"
              block
              loading={busy}
              label={t(`${A}.enroll.confirm`)}
              onPress={() => void verify()}
            />
          </>
        ) : (
          <>
            <TextField
              testID="settings-security-enroll-label"
              label={t(`${A}.enroll.label`)}
              help={t(`${A}.enroll.labelHelp`)}
              value={label}
              onChangeText={setLabel}
            />
            {error ? <InlineAlert tone="danger" message={error} /> : null}
            <Button
              testID="settings-security-enroll-start"
              block
              loading={busy}
              label={t(`${A}.enroll.start`)}
              onPress={() => {
                const checked = checkFactorLabel(label);
                if (!checked.ok) {
                  setError(
                    t(Object.values(checked.errors)[0] ?? `${A}.errors.factor_label_length`),
                  );
                  return;
                }
                void start(checked.value.label);
              }}
            />
          </>
        )}
        <Button
          testID="settings-security-enroll-cancel"
          variant="ghost"
          block
          label={t(`${A}.enroll.cancel`)}
          onPress={cancel}
        />
      </View>
    </Sheet>
  );
}

/** Two-step verification: the person's verified factors, each renamed or removed, and adding an authenticator app. */
export function FactorsCard({
  data,
  stepUp,
}: {
  readonly data: SecurityData;
  readonly stepUp: StepUp;
}): ReactElement {
  const { t } = useTranslation();
  const { client, network, config } = useCompass();
  const db = client as unknown as XosClient;
  const { date } = useDate();
  const [enrolling, setEnrolling] = useState(false);
  const [renaming, setRenaming] = useState<SecondFactor | null>(null);
  const [removing, setRemoving] = useState<SecondFactor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const offline = !network.isConnected;
  const name = (f: SecondFactor) => f.label || t(`${A}.factorTypes.${f.type}`);
  const verified = Array.isArray(data.factors) ? data.factors.filter((f) => f.verified) : [];

  const remove = async (factor: SecondFactor): Promise<void> => {
    setError(null);
    const removed = await removeSecondFactor(db, factor.id);
    if (!removed.ok) {
      if (isStepUpRefusal(removed.error)) stepUp.require(() => remove(factor));
      else setError(t(securityErrorKey(removed.error)));
      return;
    }
    // Recovery codes stand in for a second factor: without one left they go (A99, migration 1560).
    await pruneRecoveryCodes(db);
    setNotice(`${A}.factors.removed`);
    data.reload();
  };

  return (
    <Card testID="settings-security-factors" title={t(`${A}.factors.title`)}>
      <Text variant="text13" tone="tertiary">
        {t(`${A}.factors.description`)}
      </Text>
      {data.factors === null && !offline ? (
        <Skeleton lines={2} />
      ) : data.factors === "failed" ? (
        <InlineAlert tone="danger" message={t(`${A}.errors.unexpected`)} />
      ) : verified.length === 0 ? (
        <Text tone="secondary">{t(`${A}.factors.none`)}</Text>
      ) : (
        verified.map((f) => (
          <ListRow
            key={f.id}
            testID="settings-security-factor"
            title={name(f)}
            subtitle={`${t(`${A}.factorTypes.${f.type}`)} · ${t(`${A}.factors.added`, { date: date(f.createdAt) })}`}
            trailing={
              <View style={{ alignItems: "flex-end" }}>
                <Button
                  testID="settings-security-factor-rename"
                  variant="ghost"
                  label={t(`${A}.factors.rename`)}
                  disabled={offline}
                  onPress={() => setRenaming(f)}
                />
                <Button
                  testID="settings-security-factor-remove"
                  variant="ghost"
                  label={t(`${A}.factors.remove`)}
                  disabled={offline}
                  onPress={() => {
                    setError(null);
                    setRemoving(f);
                  }}
                />
              </View>
            }
          />
        ))
      )}
      {notice ? (
        <InlineAlert testID="settings-security-factors-notice" tone="success" message={t(notice)} />
      ) : null}
      {error ? (
        <InlineAlert testID="settings-security-factors-error" tone="danger" message={error} />
      ) : null}
      <Button
        testID="settings-security-factor-add"
        variant="secondary"
        icon="plus"
        label={t(`${A}.enroll.start`)}
        disabled={offline}
        onPress={() => {
          setNotice(null);
          setError(null);
          // Adding a factor beside one held asks for it first (Supabase Auth wants aal2), before the sheet opens.
          void stepUp.guard(STEP_UP["addFactor"] ?? "if-factor", holdsFactor(data), async () =>
            setEnrolling(true),
          );
        }}
      />
      <ListRow
        testID="settings-security-keys-gateway"
        icon="external-link"
        title={t(`${S}.keysInGateway`)}
        subtitle={t(`${S}.keysInGatewayHelp`)}
        onPress={() =>
          void Linking.openURL(gatewaySectionUrl(config.gatewayUrl, "/settings/security"))
        }
      />
      <Text variant="text13" tone="tertiary">
        {t(`${A}.enroll.recovery`)}
      </Text>
      <EnrollSheet
        open={enrolling}
        onClose={() => setEnrolling(false)}
        onDone={() => {
          setEnrolling(false);
          setNotice(`${A}.enroll.done`);
          data.reload();
        }}
      />
      <RenameSheet
        target={renaming ? { name: name(renaming) } : null}
        onClose={() => setRenaming(null)}
        onSave={async (label) => {
          if (!renaming) return null;
          const renamed = await renameSecondFactor(db, renaming.id, label);
          if (!renamed.ok) return securityErrorKey(renamed.error);
          setNotice(`${A}.factors.renamed`);
          data.reload();
          return null;
        }}
      />
      <ConfirmSheet
        testID="settings-security-factor-remove-confirm"
        open={removing !== null}
        title={t(`${A}.factors.removeTitle`, { name: removing ? name(removing) : "" })}
        sentence={t(`${A}.factors.removeSentence`)}
        confirmLabel={t(`${A}.factors.remove`)}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          // The confirmation closes before any step-up sheet opens: iOS shows one sheet at a time.
          const factor = removing;
          setRemoving(null);
          if (factor)
            void stepUp.guard(STEP_UP["removeFactor"] ?? "always", true, () => remove(factor));
        }}
      />
    </Card>
  );
}

/** Shown in place of the cards' controls offline: Security needs the server's answer for everything. */
export function SecurityOffline(): ReactElement {
  return <OfflineNotice kind="needs" testID="settings-security-offline" />;
}
