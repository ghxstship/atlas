/**
 * The second factor after the first (Section 9, A77): a code from the authenticator app the person set up in
 * Atlas or Gateway, or one of the recovery codes they saved there (A99). When their org requires a second factor
 * and they have none, it says where to set one up.
 */
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type { ChallengeFactor } from "../runtime/assurance";
import { redeemRecoveryCode, verifySecondFactor } from "../runtime/assurance";
import { useCompass } from "../runtime/CompassProvider";
import { Button, InlineAlert, Screen, Text, TextField, useTheme } from "../ui";

export function SecondFactor({
  factors,
}: {
  readonly factors: readonly ChallengeFactor[];
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, signOut } = useCompass();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const factor = factors[0];

  const submitRecovery = async () => {
    if (!/^[0-9a-z]{5}-?[0-9a-z]{5}$/i.test(code.replace(/\s/g, ""))) {
      setError(t("compass.secondFactor.recoveryInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await redeemRecoveryCode(client, code);
    setBusy(false);
    // Success refreshes the session; the provider then opens Compass.
    if (result !== "ok") {
      setError(
        t(
          result === "network"
            ? "compass.signIn.network"
            : result === "locked"
              ? "compass.secondFactor.recoveryLocked"
              : "compass.secondFactor.recoveryInvalid",
        ),
      );
    }
  };

  const submit = async () => {
    if (recovery) return submitRecovery();
    if (!factor) return;
    if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) {
      setError(t("compass.secondFactor.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await verifySecondFactor(client, factor.id, code);
    setBusy(false);
    // Success refreshes the session; the provider then opens Compass.
    if (result !== "ok") {
      setError(t(result === "network" ? "compass.signIn.network" : "compass.secondFactor.invalid"));
    }
  };

  return (
    <Screen testID="second-factor" title={t("compass.secondFactor.title")}>
      <Text tone="secondary">
        {t(recovery ? "compass.secondFactor.recoverySentence" : "compass.secondFactor.sentence")}
      </Text>
      <View style={{ gap: theme.space["16"] }}>
        {recovery ? (
          <TextField
            key="recovery"
            testID="second-factor-recovery-code"
            label={t("compass.secondFactor.recoveryCode")}
            value={code}
            onChangeText={setCode}
          />
        ) : (
          <TextField
            key="code"
            testID="second-factor-code"
            label={t("compass.secondFactor.code")}
            value={code}
            onChangeText={setCode}
            keyboard="numeric"
            autoComplete="one-time-code"
          />
        )}
        {error ? <InlineAlert tone="danger" message={error} /> : null}
        <Button
          testID="second-factor-submit"
          size="lg"
          block
          loading={busy}
          label={t("compass.secondFactor.verify")}
          onPress={() => void submit()}
        />
        <Button
          testID="second-factor-switch"
          variant="ghost"
          label={t(recovery ? "compass.secondFactor.useApp" : "compass.secondFactor.useRecovery")}
          onPress={() => {
            setRecovery((on) => !on);
            setCode("");
            setError(null);
          }}
        />
        <Button
          testID="second-factor-sign-out"
          variant="ghost"
          label={t("compass.settings.signOut")}
          onPress={() => void signOut()}
        />
      </View>
    </Screen>
  );
}

/** The org requires a second factor and the person has none yet: set one up in Atlas or Gateway first. */
export function SecondFactorRequired(): ReactElement {
  const { t } = useTranslation();
  const { signOut, retryIdentity } = useCompass();
  return (
    <Screen testID="second-factor-required" title={t("compass.secondFactor.requiredTitle")}>
      <Text tone="secondary">{t("compass.secondFactor.required")}</Text>
      <Button
        testID="second-factor-retry"
        block
        label={t("compass.common.retry")}
        onPress={retryIdentity}
      />
      <Button
        testID="second-factor-required-sign-out"
        variant="ghost"
        label={t("compass.settings.signOut")}
        onPress={() => void signOut()}
      />
    </Screen>
  );
}
