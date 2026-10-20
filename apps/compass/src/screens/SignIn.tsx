/**
 * Sign-in: Continue with Google and an email link first, a password last (Section 11.10 item 12:
 * passwordless by default). Google appears when the build carries its client IDs (ADR 0036).
 */
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, View } from "react-native";
import googleMark from "../assets/google-mark.png";
import { signInWithGoogle } from "../domain/googleSignIn";
import { useCompass } from "../runtime/CompassProvider";
import { googleClientIds, googleOffered, loadGoogleNative } from "../runtime/google";
import { Button, InlineAlert, Screen, Text, TextField, useTheme } from "../ui";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Message = { tone: "danger" | "success" | "info"; text: string };

/**
 * Continue with Google: Google's "G" in its own colors (Google's sign-in branding guidelines) on the
 * secondary button style. The label is the accessible name; the mark is decorative.
 */
function GoogleButton({
  label,
  busy,
  onPress,
}: {
  label: string;
  busy: boolean;
  onPress: () => void;
}): ReactElement {
  const theme = useTheme();
  return (
    <Pressable
      testID="sign-in-google"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: theme.space["48"] + theme.space["8"],
        paddingHorizontal: theme.space["20"],
        borderRadius: theme.radius.control,
        backgroundColor: theme.color.bgRaised,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderControl,
        opacity: busy ? theme.opacity.disabled : pressed ? 1 - theme.opacity.pressed : 1,
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: theme.space["8"],
      })}
    >
      <Image
        source={googleMark}
        accessibilityIgnoresInvertColors
        importantForAccessibility="no"
        style={{ width: theme.iconSize["20"], height: theme.iconSize["20"] }}
      />
      <Text variant="heading20">{label}</Text>
    </Pressable>
  );
}

export function SignIn(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client } = useCompass();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [google] = useState(googleOffered);
  const emailError =
    email.length > 3 && !EMAIL.test(email.trim()) ? t("compass.signIn.emailInvalid") : undefined;

  const continueWithGoogle = async () => {
    const ids = googleClientIds();
    if (!ids) return;
    setGoogleBusy(true);
    setMessage(null);
    const outcome = await signInWithGoogle(await loadGoogleNative(), client.auth, ids);
    setGoogleBusy(false);
    if (outcome.kind === "cancelled") {
      setMessage({ tone: "info", text: t("compass.signIn.googleCancelled") });
    } else if (outcome.kind === "refused") {
      setMessage({ tone: "danger", text: t(`compass.signIn.${outcome.message}`) });
    }
  };

  const submit = async () => {
    if (!EMAIL.test(email.trim())) {
      setMessage({ tone: "danger", text: t("compass.signIn.emailInvalid") });
      return;
    }
    setBusy(true);
    setMessage(null);
    const address = email.trim();
    const result = usePassword
      ? await client.auth.signInWithPassword({ email: address, password })
      : await client.auth.signInWithOtp({
          email: address,
          options: { emailRedirectTo: "compass://sign-in" },
        });
    setBusy(false);
    if (result.error) {
      const network = result.error.status === 0 || /fetch|network/i.test(result.error.message);
      setMessage({
        tone: "danger",
        text: t(network ? "compass.signIn.network" : "compass.signIn.invalid"),
      });
    } else if (!usePassword) {
      setMessage({ tone: "success", text: t("compass.signIn.linkSent", { email: address }) });
    }
  };

  return (
    <Screen testID="sign-in" title={t("compass.signIn.title")}>
      <Text tone="secondary">{t("compass.signIn.sentence")}</Text>
      <View style={{ gap: theme.space["16"] }}>
        {google ? (
          <>
            <GoogleButton
              label={t("compass.signIn.google")}
              busy={googleBusy}
              onPress={() => void continueWithGoogle()}
            />
            <Text variant="text13" tone="tertiary">
              {t("compass.signIn.or")}
            </Text>
          </>
        ) : null}
        <TextField
          testID="sign-in-email"
          label={t("compass.signIn.email")}
          value={email}
          onChangeText={setEmail}
          keyboard="email"
          autoComplete="email"
          {...(emailError ? { error: emailError } : {})}
        />
        {usePassword ? (
          <TextField
            testID="sign-in-password"
            label={t("compass.signIn.password")}
            value={password}
            onChangeText={setPassword}
            secure
            autoComplete="password"
          />
        ) : null}
        {message ? <InlineAlert tone={message.tone} message={message.text} /> : null}
        <Button
          testID="sign-in-submit"
          size="lg"
          block
          loading={busy}
          label={t(usePassword ? "compass.signIn.submit" : "compass.signIn.sendLink")}
          onPress={() => void submit()}
        />
        <Button
          testID="sign-in-toggle"
          variant="ghost"
          label={t(usePassword ? "compass.signIn.useLink" : "compass.signIn.usePassword")}
          onPress={() => {
            setUsePassword(!usePassword);
            setMessage(null);
          }}
        />
      </View>
    </Screen>
  );
}
