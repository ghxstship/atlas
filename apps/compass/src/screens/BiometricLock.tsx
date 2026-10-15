/**
 * Biometric unlock (Section 13 device security): when the person turns it on, Compass asks for Face ID,
 * Touch ID or the device passcode each time it opens or returns from the background.
 */
import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { Button, InlineAlert, Screen, Text } from "../ui";

export function BiometricLock({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const [locked, setLocked] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const unlock = async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t("compass.lock.prompt"),
      disableDeviceFallback: false,
    });
    setFailed(!result.success);
    if (result.success) setLocked(false);
  };
  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      return undefined;
    }
    // Settings load after launch, so the lock engages when the stored preference arrives.
    setLocked(true);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") setLocked(true);
    });
    return () => subscription.remove();
  }, [enabled]);
  useEffect(() => {
    if (enabled && locked) void unlock();
    // Only re-prompt when the lock engages, not on every render.
  }, [enabled, locked]);
  if (!enabled || !locked) return <>{children}</>;
  return (
    <Screen testID="biometric-lock" title={t("compass.lock.title")}>
      <Text tone="secondary">{t("compass.lock.sentence")}</Text>
      {failed ? <InlineAlert tone="warning" message={t("compass.lock.failed")} /> : null}
      <Button
        testID="biometric-unlock"
        size="lg"
        block
        icon="key-round"
        label={t("compass.lock.unlock")}
        onPress={() => void unlock()}
      />
    </Screen>
  );
}
