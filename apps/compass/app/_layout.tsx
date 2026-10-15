import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CompassProvider, useCompass } from "../src/runtime/CompassProvider";
import { initI18n } from "../src/runtime/i18n";
import { SignIn } from "../src/screens/SignIn";
import { ErrorState, Screen, Skeleton, ThemeProvider, useTheme } from "../src/ui";

initI18n();

function Gatekeeper(): ReactElement {
  const { phase, retryIdentity, settings } = useCompass();
  const { t } = useTranslation();
  const theme = useTheme();
  if (phase.kind === "starting") {
    return (
      <Screen testID="starting">
        <Skeleton lines={4} />
      </Screen>
    );
  }
  if (phase.kind === "signed-out") return <SignIn />;
  if (phase.kind === "identity-failed") {
    return (
      <Screen testID="identity-failed">
        <ErrorState
          title={t("compass.signIn.identityTitle")}
          sentence={t("compass.signIn.identity", { step: phase.step })}
          reference={phase.message}
          actionLabel={t("compass.common.retry")}
          onRetry={retryIdentity}
        />
      </Screen>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bgCanvas }}>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.color.bgCanvas },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="kiosk" options={{ gestureEnabled: settings.kioskDeviceKey === null }} />
      </Stack>
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
