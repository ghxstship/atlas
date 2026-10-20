import type { XosClient } from "@xos/data/client";
import {
  ACCOUNT_SUPPORT_CATEGORIES,
  openAccountSupportRequest,
  type AccountSupportCategory,
} from "@xos/data/support";
import { isInternal } from "@xos/sync";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter, type Href } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { lastHelpScreen } from "../../src/runtime/help";
import { useCompass } from "../../src/runtime/CompassProvider";
import {
  Button,
  Card,
  InlineAlert,
  Screen,
  SegmentedControl,
  Switch,
  Text,
  TextField,
} from "../../src/ui";

/**
 * Contact Support in Compass (Section 11.16). Members ask their own organization's teams in the Help
 * Desk (Section 4.9). External users ask the organization that engaged them in Gateway Messages.
 * Everyone may ask platform support about their own account (migration 1300); a request needs the
 * server for its number, so it is sent online, and diagnostics go only with the switch on.
 */
export default function ContactSupportScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { resolved, status, client, config } = useCompass();
  const internal = resolved ? isInternal(resolved.identity.audience) : false;
  const [category, setCategory] = useState<AccountSupportCategory>("Account");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const screen = lastHelpScreen() ?? "/help";
  const version = Constants.expoConfig?.version ?? "";
  const device = `${Platform.OS} ${String(Platform.Version)}`;

  const send = async () => {
    if (subject.trim() === "" || body.trim() === "") {
      setMissing(true);
      return;
    }
    if (status && !status.online) {
      setProblem(t("compass.help.contact.offline"));
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await openAccountSupportRequest(client as unknown as XosClient, {
      category,
      subject: subject.trim(),
      body: body.trim(),
      diagnostics: diagnostics ? { route: screen, appVersion: version || null, device } : null,
    });
    setBusy(false);
    if (result.ok) {
      setSent(result.data);
      return;
    }
    const error = result.error;
    setProblem(
      t(
        error.kind === "refusal" && error.rule === "account_support_limit"
          ? "compass.help.contact.errors.limit"
          : error.kind === "refusal" || error.kind === "invalid"
            ? "compass.help.contact.errors.invalid"
            : "compass.help.contact.errors.unexpected",
      ),
    );
  };

  return (
    <Screen testID="help-contact" title={t("compass.help.contact.title")}>
      {internal ? (
        <Card title={t("compass.help.contact.orgTitle")}>
          <Text tone="secondary">{t("compass.help.contact.orgBody")}</Text>
          <Button
            testID="help-contact-help-desk"
            variant="secondary"
            icon="users"
            label={t("compass.help.contact.orgAction")}
            onPress={() => router.push("/workforce/help-desk" as Href)}
          />
        </Card>
      ) : (
        <Card title={t("compass.help.contact.workTitle")}>
          <Text tone="secondary">{t("compass.help.contact.workBody")}</Text>
          <Button
            testID="help-contact-messages"
            variant="secondary"
            icon="inbox"
            label={t("compass.help.contact.workAction")}
            onPress={() => void Linking.openURL(`${config.gatewayUrl}/messages`)}
          />
        </Card>
      )}
      <Card title={t("compass.help.contact.accountTitle")}>
        <Text tone="secondary">{t("compass.help.contact.accountBody")}</Text>
        {sent ? (
          <InlineAlert
            testID="help-contact-sent"
            tone="success"
            message={t("compass.help.contact.sent", { number: sent })}
          />
        ) : (
          <>
            <SegmentedControl
              testID="help-contact-category"
              label={t("compass.help.contact.category")}
              value={category}
              options={ACCOUNT_SUPPORT_CATEGORIES.map((c) => ({
                value: c,
                label: t(`compass.help.contact.categories.${c}`),
              }))}
              onChange={(v) => setCategory(v as AccountSupportCategory)}
            />
            <TextField
              testID="help-contact-subject"
              label={t("compass.help.contact.subject")}
              value={subject}
              onChangeText={setSubject}
              {...(missing && subject.trim() === ""
                ? { error: t("compass.help.contact.required") }
                : {})}
            />
            <TextField
              testID="help-contact-body"
              label={t("compass.help.contact.body")}
              value={body}
              multiline
              onChangeText={setBody}
              {...(missing && body.trim() === ""
                ? { error: t("compass.help.contact.required") }
                : {})}
            />
            <Switch
              testID="help-contact-diagnostics"
              label={t("compass.help.contact.diagnostics")}
              help={t("compass.help.contact.diagnosticsHelp", { screen, version, device })}
              value={diagnostics}
              onChange={setDiagnostics}
            />
            {problem ? (
              <InlineAlert testID="help-contact-problem" tone="warning" message={problem} />
            ) : null}
            <Button
              testID="help-contact-send"
              block
              loading={busy}
              label={t("compass.help.contact.send")}
              onPress={() => void send()}
            />
          </>
        )}
      </Card>
    </Screen>
  );
}
