import * as Linking from "expo-linking";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CompassProvider, useCompass } from "../src/runtime/CompassProvider";
import { playHaptic } from "../src/runtime/haptics";
import { HelpScreenTracker } from "../src/runtime/help";
import { initI18n } from "../src/runtime/i18n";
import { useUpdateGate } from "../src/runtime/minimumVersion";
import { useActionableNotifications } from "../src/runtime/notifications";
import { BiometricLock } from "../src/screens/BiometricLock";
import { DeleteAccount } from "../src/screens/DeleteAccount";
import { SecondFactor, SecondFactorRequired } from "../src/screens/SecondFactor";
import { SignIn } from "../src/screens/SignIn";
import {
  Button,
  ErrorState,
  ForceUpdateScreen,
  Screen,
  Skeleton,
  ThemeProvider,
  useTheme,
} from "../src/ui";
import { NativeHeaderContext } from "../src/ui/layout";

initI18n();

/** Actionable push notifications (journey 57) for the signed-in person; renders nothing. */
function NotificationActions(): null {
  useActionableNotifications();
  return null;
}

function Gatekeeper(): ReactElement {
  const { phase, retryIdentity, settings, client, signOut } = useCompass();
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  // The delete screen belongs to this failed sign-in only; the next sign-in starts from the error screen.
  useEffect(() => {
    if (phase.kind !== "identity-failed") setDeleting(false);
  }, [phase.kind]);
  const theme = useTheme();
  const update = useUpdateGate(client);
  // Below the server-advertised minimum version nothing else runs, signed in or not (Section 5.1).
  if (update.blocked && update.floor) {
    const url = update.floor.updateUrl;
    return (
      <ForceUpdateScreen
        testID="force-update"
        message={t(url ? "compass.update.message" : "compass.update.messageNoLink")}
        version={t("compass.update.versions", {
          current: update.current,
          minimum: update.floor.minimumVersion,
        })}
        actionLabel={t(url ? "compass.update.action" : "compass.update.recheck")}
        onUpdate={() => void (url ? Linking.openURL(url) : update.recheck())}
      />
    );
  }
  if (phase.kind === "starting") {
    return (
      <Screen testID="starting">
        <Skeleton lines={4} />
      </Screen>
    );
  }
  if (phase.kind === "signed-out") return <SignIn />;
  if (phase.kind === "second-factor") return <SecondFactor factors={phase.factors} />;
  if (phase.kind === "factor-required") return <SecondFactorRequired />;
  if (phase.kind === "identity-failed") {
    // A sign-in with no membership or engagement can still sign out or delete itself (SIM-004).
    if (deleting) return <DeleteAccount />;
    return (
      <Screen testID="identity-failed">
        <ErrorState
          title={t("compass.signIn.identityTitle")}
          sentence={t("compass.signIn.identity", { step: phase.step })}
          reference={phase.message}
          actionLabel={t("compass.common.retry")}
          onRetry={retryIdentity}
        />
        <Button
          testID="identity-failed-sign-out"
          variant="secondary"
          icon="log-out"
          block
          label={t("compass.settings.signOut")}
          onPress={() => void signOut()}
        />
        <Button
          testID="identity-failed-delete-account"
          variant="secondary"
          icon="ban"
          block
          label={t("compass.settings.deleteAccount")}
          onPress={() => setDeleting(true)}
        />
      </Screen>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bgCanvas }}>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <NotificationActions />
      <HelpScreenTracker />
      <BiometricLock enabled={settings.biometric}>
        <NativeHeaderContext.Provider value={true}>
          <Stack
            screenOptions={{
              // Pushed screens use the native large-title header: the back button, so they can be left by
              // keyboard, Switch Control and VoiceOver, and the title, which collapses into the bar on
              // scroll. Each Screen sets its title there instead of drawing it under an empty bar
              // (finding A59-031).
              headerShown: true,
              title: "",
              headerLargeTitle: true,
              headerLargeTitleShadowVisible: false,
              headerBackButtonDisplayMode: "minimal",
              headerShadowVisible: false,
              headerStyle: { backgroundColor: theme.color.bgCanvas },
              headerLargeStyle: { backgroundColor: theme.color.bgCanvas },
              headerTitleStyle: { color: theme.color.textPrimary },
              headerLargeTitleStyle: { color: theme.color.textPrimary },
              headerTintColor: theme.color.textPrimary,
              contentStyle: { backgroundColor: theme.color.bgCanvas },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="kiosk"
              options={{ headerShown: false, gestureEnabled: settings.kioskDeviceKey === null }}
            />
          </Stack>
        </NativeHeaderContext.Provider>
      </BiometricLock>
    </View>
  );
}

function Themed(): ReactElement {
  const scheme = useColorScheme();
  const { settings } = useCompass();
  return (
    <ThemeProvider
      preference={settings.theme}
      systemColorScheme={scheme === "light" || scheme === "dark" ? scheme : null}
      {...(settings.haptics ? { onHaptic: playHaptic } : {})}
    >
      <Gatekeeper />
    </ThemeProvider>
  );
}

export default function RootLayout(): ReactElement {
  return (
    <SafeAreaProvider>
      <CompassProvider>
        <Themed />
      </CompassProvider>
    </SafeAreaProvider>
  );
}
