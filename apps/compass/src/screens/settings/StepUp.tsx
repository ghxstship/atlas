/**
 * Step-up in Compass Settings (A77's rule, migration 1333; ADR 0070): before a change to how the person signs in,
 * a second factor passed in the last 15 minutes. The sheet asks for a code from the authenticator app, or one of the
 * person's recovery codes (A99), then resumes the change. A person whose only second factor is a security key
 * confirms in Gateway, since Compass cannot use one.
 */
import { getRecoveryCodeStatus } from "@xos/data/account-security";
import { getSecondFactorStatus, listSecondFactors } from "@xos/data/auth-assurance";
import type { XosClient } from "@xos/data/client";
import * as Linking from "expo-linking";
import { useCallback, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { redeemRecoveryCode, verifySecondFactor } from "../../runtime/assurance";
import { useCompass } from "../../runtime/CompassProvider";
import { checkRecoveryCode, checkTotpCode } from "../../settings/forms";
import { gatewaySectionUrl } from "../../settings/sections";
import { needsStepUp, type StepUpRule } from "../../settings/security";
import { Button, InlineAlert, Sheet, Skeleton, Text, TextField, useTheme } from "../../ui";

/** How long a closing sheet takes to leave, before the step-up sheet opens in its place. */
const SHEET_HANDOFF_MS = 400;

type Methods =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly totp: readonly { readonly id: string; readonly label: string }[];
      readonly recovery: boolean;
    };

export interface StepUp {
  /** The sheet; render it once on the screen. */
  readonly sheet: ReactElement;
  /**
   * Runs `action`, first asking for a recent second factor when the rule says so. `holdsFactor` is whether the
   * person holds a verified second factor.
   */
  readonly guard: (
    rule: StepUpRule,
    holdsFactor: boolean,
    action: () => Promise<void>,
  ) => Promise<void>;
  /** Asks for a second factor now, then runs `action`: for a change the server refused with step_up_required. */
  readonly require: (action: () => Promise<void>) => void;
}

export function useStepUp(testID = "step-up"): StepUp {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, config } = useCompass();
  const db = client as unknown as XosClient;
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<Methods>({ kind: "loading" });
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<(() => Promise<void>) | null>(null);

  const load = useCallback(async () => {
    setMethods({ kind: "loading" });
    const [factors, codes] = await Promise.all([listSecondFactors(db), getRecoveryCodeStatus(db)]);
    if (!factors.ok) {
      setMethods({ kind: "failed" });
      return;
    }
    const totp = factors.data
      .filter((f) => f.verified && f.type === "totp")
      .map((f) => ({ id: f.id, label: f.label }));
    const recovery = codes.ok && codes.data.usable;
    setMethods({ kind: "ready", totp, recovery });
    setRecoveryMode(totp.length === 0 && recovery);
  }, [db]);

  const require = useCallback(
    (action: () => Promise<void>) => {
      pending.current = action;
      setCode("");
      setError(null);
      void load();
      // A confirmation sheet that just closed is still sliding away, and iOS presents one sheet at a time.
      setTimeout(() => setOpen(true), SHEET_HANDOFF_MS);
    },
    [load],
  );

  const guard = useCallback(
    async (rule: StepUpRule, holdsFactor: boolean, action: () => Promise<void>) => {
      const status = await getSecondFactorStatus(db);
      // An unreadable status asks for the factor: the check fails closed, as requireSecondFactor does.
      const recent = status.ok && status.data.recent;
      if (needsStepUp(rule, holdsFactor, recent)) require(action);
      else await action();
    },
    [db, require],
  );

  const close = () => {
    pending.current = null;
    setOpen(false);
  };

  const verify = async () => {
    if (methods.kind !== "ready") return;
    const checked = recoveryMode ? checkRecoveryCode(code) : checkTotpCode(code);
    if (!checked.ok) {
      setError(t(Object.values(checked.errors)[0] ?? "authSecurity.errors.code_invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    const factor = methods.totp[0];
    const result = recoveryMode
      ? await redeemRecoveryCode(client, checked.value.code)
      : factor
        ? await verifySecondFactor(client, factor.id, checked.value.code)
        : "invalid";
    setBusy(false);
    if (result !== "ok") {
      setError(
        t(
          result === "network"
            ? "compassSettings.common.offlineNeeds"
            : result === "locked"
              ? "authSecurity.errors.recovery_rate_limited"
              : recoveryMode
                ? "authSecurity.errors.recovery_invalid"
                : "authSecurity.errors.code_invalid",
        ),
      );
      return;
    }
    const action = pending.current;
    pending.current = null;
    setOpen(false);
    if (action) await action();
  };

  const sheet = (
    <Sheet
      testID={testID}
      open={open}
      title={t("authSecurity.stepUp.title")}
      closeLabel={t("compass.common.close")}
      onClose={close}
    >
      <View style={{ gap: theme.space["16"] }}>
        {methods.kind === "loading" ? (
          <Skeleton testID={`${testID}-loading`} lines={2} />
        ) : methods.kind === "failed" ? (
          <InlineAlert
            testID={`${testID}-failed`}
            tone="danger"
            message={t("authSecurity.errors.unexpected")}
          />
        ) : methods.totp.length === 0 && !methods.recovery ? (
          <>
            <Text tone="secondary">{t("compassSettings.stepUp.elsewhere")}</Text>
            <Button
              testID={`${testID}-gateway`}
              variant="secondary"
              icon="external-link"
              block
              label={t("compass.common.openGateway")}
              onPress={() =>
                void Linking.openURL(gatewaySectionUrl(config.gatewayUrl, "/settings/security"))
              }
            />
          </>
        ) : (
          <>
            <Text tone="secondary">
              {t(
                recoveryMode
                  ? "compassSettings.stepUp.recoverySentence"
                  : "authSecurity.stepUp.sentence",
              )}
            </Text>
            {recoveryMode ? (
              <TextField
                key="recovery"
                testID={`${testID}-recovery-code`}
                label={t("authSecurity.recovery.code")}
                help={t("authSecurity.recovery.codeHelp")}
                value={code}
                onChangeText={setCode}
                autoComplete="off"
              />
            ) : (
              <TextField
                key="code"
                testID={`${testID}-code`}
                label={t("compass.secondFactor.code")}
                value={code}
                onChangeText={setCode}
                keyboard="numeric"
                autoComplete="one-time-code"
              />
            )}
            {error ? (
              <InlineAlert testID={`${testID}-error`} tone="danger" message={error} />
            ) : null}
            <Button
              testID={`${testID}-verify`}
              block
              loading={busy}
              label={t("compass.secondFactor.verify")}
              onPress={() => void verify()}
            />
            {methods.totp.length > 0 && methods.recovery ? (
              <Button
                testID={`${testID}-switch`}
                variant="ghost"
                block
                label={t(
                  recoveryMode ? "compass.secondFactor.useApp" : "compass.secondFactor.useRecovery",
                )}
                onPress={() => {
                  setRecoveryMode((on) => !on);
                  setCode("");
                  setError(null);
                }}
              />
            ) : null}
          </>
        )}
      </View>
    </Sheet>
  );

  return { sheet, guard, require };
}
