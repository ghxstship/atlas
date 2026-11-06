import type { XosClient } from "@xos/data/client";
import { confirmMinimumAge, refuseMinimumAge, type AgeRefusal } from "@xos/data/consent";
import { recordLegalAcceptances } from "@xos/data/settings";
import * as Linking from "expo-linking";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { revokeAppleBeforeDeletion } from "../domain/appleSignIn";
import { formatCalendarDay } from "../domain/dates";
import { acceptancesOf, heldReason, type HeldReason, type LegalNeeds } from "../domain/legalGate";
import {
  accountSignsInWithApple,
  appleAvailable,
  appleRevoker,
  loadAppleNative,
} from "../runtime/apple";
import { useCompass } from "../runtime/CompassProvider";
import { forgetGoogleAccount } from "../runtime/google";
import { Button, Card, InlineAlert, Screen, Switch, Text, useTheme } from "../ui";

type Step =
  | { readonly kind: "age" }
  | { readonly kind: "under" }
  | { readonly kind: "documents" }
  | { readonly kind: "declined" }
  | { readonly kind: "refused" }
  | { readonly kind: "held"; readonly reason: HeldReason; readonly org: string };

/**
 * What Compass asks before anything else (legal issue 4, ADR 0156): the age, then the Mobile EULA and, where they apply,
 * the Worker Terms. Nothing has been downloaded yet when this shows, and every answer goes to the server, in the same
 * log web sign-up writes, before Compass opens. The age question offers both answers with equal weight and states no rule
 * until it is answered. An answer of under 18 closes the account (app.refuse_minimum_age).
 *
 * `onLater` is set when the person chose to review a change still in its notice period, which never holds them.
 */
export function LegalGate({
  needs,
  onLater,
}: {
  readonly needs: LegalNeeds;
  readonly onLater?: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { client, config, signOut, store, retryIdentity } = useCompass();
  const xos = client as unknown as XosClient;
  const [step, setStep] = useState<Step>(needs.age ? { kind: "age" } : { kind: "documents" });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toAccept = acceptancesOf(needs);
  const open = (slug: string) => void Linking.openURL(`${config.atlasUrl}/legal/${slug}`);

  /** Runs one server step; a failure says Compass needs a connection and keeps the screen as it is. */
  const attempt = async (run: () => Promise<boolean>) => {
    setBusy(true);
    setFailed(false);
    const done = await run().catch(() => false);
    if (!done) {
      setFailed(true);
      setBusy(false);
    }
    return done;
  };

  const confirmAge = async () => {
    const done = await attempt(async () => (await confirmMinimumAge(xos, "Compass", null)).ok);
    if (!done) return;
    setBusy(false);
    if (toAccept.length > 0) setStep({ kind: "documents" });
    else retryIdentity();
  };

  const accept = async () => {
    const done = await attempt(
      async () =>
        (
          await recordLegalAcceptances(xos, {
            orgId: null,
            documents: toAccept,
            clientIp: null,
          })
        ).ok,
    );
    // The server is asked again, so only what it recorded lets Compass open.
    if (done) retryIdentity();
  };

  const refuse = async () => {
    const answer: { refusal?: AgeRefusal } = {};
    const done = await attempt(async () => {
      // Apple's sheet comes first, while the account still exists; neither closing it nor a failure holds up the refusal.
      await revokeAppleBeforeDeletion({
        signedInWithApple: await accountSignsInWithApple(xos),
        appleOnDevice: await appleAvailable(),
        native: loadAppleNative,
        revoke: appleRevoker(xos, config.supabaseUrl),
      }).catch(() => undefined);
      const refused = await refuseMinimumAge(xos, "Compass");
      if (!refused.ok) return false;
      answer.refusal = refused.data;
      return true;
    });
    if (!done || !answer.refusal) return;
    setBusy(false);
    setStep(
      answer.refusal.outcome === "Account Held"
        ? {
            kind: "held",
            reason: heldReason(answer.refusal.reason),
            org: answer.refusal.orgName ?? "",
          }
        : { kind: "refused" },
    );
  };

  /** The sign-in no longer exists on the server, or may not be used: forget it on this device only. */
  const leave = async () => {
    setBusy(true);
    await store?.wipe();
    await forgetGoogleAccount();
    await client.auth.signOut({ scope: "local" });
  };

  const problem = failed ? (
    <InlineAlert
      testID="legal-gate-failed"
      tone="danger"
      message={t("compass.legalGate.needsConnection")}
    />
  ) : null;

  if (step.kind === "age") {
    return (
      <Screen testID="legal-gate-age" title={t("compass.legalGate.age.title")}>
        <Text tone="secondary">{t("compass.legalGate.age.sentence")}</Text>
        {problem}
        <View style={{ gap: theme.space["12"] }}>
          <Button
            testID="legal-gate-age-over"
            variant="secondary"
            size="lg"
            block
            disabled={busy}
            label={t("compass.legalGate.age.over")}
            onPress={() => void confirmAge()}
          />
          <Button
            testID="legal-gate-age-under"
            variant="secondary"
            size="lg"
            block
            disabled={busy}
            label={t("compass.legalGate.age.under")}
            onPress={() => {
              setFailed(false);
              setStep({ kind: "under" });
            }}
          />
        </View>
        <Text variant="text13" tone="tertiary">
          {t("compass.legalGate.online")}
        </Text>
      </Screen>
    );
  }

  if (step.kind === "under") {
    return (
      <Screen testID="legal-gate-under" title={t("compass.legalGate.under.title")}>
        <Text>{t("compass.legalGate.under.sentence")}</Text>
        <Text tone="secondary">{t("compass.legalGate.under.keeps")}</Text>
        {problem}
        <Button
          testID="legal-gate-under-confirm"
          variant="danger"
          block
          loading={busy}
          disabled={busy}
          label={t("compass.legalGate.under.confirm")}
          onPress={() => void refuse()}
        />
        <Button
          testID="legal-gate-under-back"
          variant="ghost"
          block
          disabled={busy}
          label={t("compass.legalGate.under.back")}
          onPress={() => setStep({ kind: "age" })}
        />
      </Screen>
    );
  }

  if (step.kind === "refused" || step.kind === "held") {
    const held = step.kind === "held";
    return (
      <Screen
        testID={held ? "legal-gate-held" : "legal-gate-refused"}
        title={t(held ? "compass.legalGate.held.title" : "compass.legalGate.refused.title")}
      >
        <Text>
          {held
            ? t(`compass.legalGate.held.${step.reason}`, { org: step.org })
            : t("compass.legalGate.refused.sentence")}
        </Text>
        <Text tone="secondary">
          {t(held ? "compass.legalGate.held.next" : "compass.legalGate.refused.minors")}
        </Text>
        {held ? (
          <Button
            testID="legal-gate-contact"
            variant="secondary"
            block
            label={t("compass.legalGate.held.contact")}
            onPress={() => open("contact")}
          />
        ) : null}
        <Button
          testID="legal-gate-leave"
          block
          loading={busy}
          disabled={busy}
          label={t("compass.common.done")}
          onPress={() => void leave()}
        />
      </Screen>
    );
  }

  if (step.kind === "declined") {
    return (
      <Screen testID="legal-gate-declined" title={t("compass.legalGate.declined.title")}>
        <Text>{t("compass.legalGate.declined.sentence")}</Text>
        <Button
          testID="legal-gate-declined-back"
          block
          label={t("compass.legalGate.declined.back")}
          onPress={() => setStep({ kind: "documents" })}
        />
        <Button
          testID="legal-gate-sign-out"
          variant="secondary"
          icon="log-out"
          block
          label={t("compass.settings.signOut")}
          onPress={() => void signOut()}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="legal-gate-documents" title={t("compass.legalGate.documents.title")}>
      <Text tone="secondary">{t("compass.legalGate.documents.lead")}</Text>
      {needs.changes.map((change) => (
        <Card
          key={change.documentSlug}
          testID={`legal-gate-change-${change.documentSlug}`}
          title={t(`compass.legalGate.documentNames.${change.documentSlug}`)}
          meta={t("compass.legalGate.documents.effective", {
            date: formatCalendarDay(change.effectiveOn, i18n.language),
          })}
        >
          <Text>{change.summary}</Text>
        </Card>
      ))}
      <View style={{ gap: theme.space["8"] }}>
        {toAccept.map((doc) => (
          <Button
            key={doc.slug}
            testID={`legal-gate-open-${doc.slug}`}
            variant="ghost"
            icon="external-link"
            block
            label={t(`compass.legalGate.documentNames.${doc.slug}`)}
            onPress={() => open(doc.slug)}
          />
        ))}
      </View>
      <Text tone="secondary">{t("compass.legalGate.documents.limits")}</Text>
      <Switch
        testID="legal-gate-agree"
        label={t("compass.legalGate.documents.agree")}
        value={agreed}
        onChange={setAgreed}
      />
      {problem}
      <Button
        testID="legal-gate-accept"
        size="lg"
        block
        loading={busy}
        disabled={busy || !agreed}
        label={t("compass.legalGate.documents.accept")}
        onPress={() => void accept()}
      />
      <Button
        testID="legal-gate-decline"
        variant="ghost"
        block
        disabled={busy}
        label={t(
          onLater ? "compass.legalGate.documents.later" : "compass.legalGate.documents.decline",
        )}
        onPress={() => (onLater ? onLater() : setStep({ kind: "declined" }))}
      />
      <Text variant="text13" tone="tertiary">
        {t("compass.legalGate.online")}
      </Text>
    </Screen>
  );
}
