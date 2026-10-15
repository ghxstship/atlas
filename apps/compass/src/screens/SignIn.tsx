/**
 * Sign-in: an email link first, a password second (Section 11.10 item 12: passwordless by default).
 */
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../runtime/CompassProvider";
import { Button, InlineAlert, Screen, Text, TextField, useTheme } from "../ui";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignIn(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client } = useCompass();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const emailError =
    email.length > 3 && !EMAIL.test(email.trim()) ? t("compass.signIn.emailInvalid") : undefined;

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
