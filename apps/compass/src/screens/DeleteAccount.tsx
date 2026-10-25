import {
  deleteMyAccount,
  previewAccountDeletion,
  type AccountDeletionPreview,
  type AccountDeletionResult,
} from "@xos/data/account-deletion";
import type { XosClient } from "@xos/data/client";
import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { revokeAppleBeforeDeletion } from "../domain/appleSignIn";
import {
  accountSignsInWithApple,
  appleAvailable,
  appleRevoker,
  loadAppleNative,
} from "../runtime/apple";
import { useCompass } from "../runtime/CompassProvider";
import {
  Button,
  Card,
  ErrorState,
  InlineAlert,
  RefusalNotice,
  Screen,
  Skeleton,
  Text,
  TextField,
} from "../ui";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "ready"; readonly preview: AccountDeletionPreview };

/**
 * Delete the account from inside Compass (SIM-004, journey 38; App Store guideline
 * 5.1.1(v)). Shows what blocks deletion and what is kept and why, asks for the sign-in email and a device
 * check (Face ID, Touch ID or passcode, when the device has one), then calls app.delete_my_account and shows
 * the confirmation. Online only: deletion never queues. Settings, Account shows it, and so does the screen a
 * sign-in with no membership or engagement lands on, so every account Compass can open can be deleted.
 * An account that signs in with Apple first confirms with Apple's sheet, so Compass's Apple tokens are revoked
 * (ADR 0033 decision 58); when Compass cannot revoke them, the confirmation says how to remove Compass from the
 * Apple Account.
 */
export function DeleteAccount(): ReactElement {
  const { t } = useTranslation();
  const { client, config, network, store } = useCompass();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ title?: string; message: string } | null>(null);
  const [done, setDone] = useState<AccountDeletionResult | null>(null);
  const [appleLeft, setAppleLeft] = useState(false);

  const check = useCallback(async () => {
    setLoad({ kind: "loading" });
    const preview = await previewAccountDeletion(client);
    setLoad(
      preview.ok
        ? { kind: "ready", preview: preview.data }
        : {
            kind: "failed",
            reason: "message" in preview.error ? preview.error.message : preview.error.kind,
          },
    );
  }, [client]);

  useEffect(() => {
    if (network.isConnected && !done) void check();
  }, [network.isConnected, check, done]);

  const confirmItIsYou = async (): Promise<boolean> => {
    const enrolled =
      (await LocalAuthentication.hasHardwareAsync()) &&
      (await LocalAuthentication.isEnrolledAsync());
    if (!enrolled) return true;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t("compass.account.stepUpPrompt"),
      disableDeviceFallback: false,
    });
    return result.success;
  };

  const remove = async () => {
    setProblem(null);
    setBusy(true);
    try {
      if (!(await confirmItIsYou())) {
        setProblem({ message: t("compass.account.stepUpFailed") });
        return;
      }
      const xos = client as unknown as XosClient;
      const apple = await revokeAppleBeforeDeletion({
        signedInWithApple: await accountSignsInWithApple(xos),
        appleOnDevice: await appleAvailable(),
        native: loadAppleNative,
        revoke: appleRevoker(xos, config.supabaseUrl),
      });
      if (apple.kind === "cancelled") {
        setProblem({ message: t("compass.account.appleCancelled") });
        return;
      }
      const result = await deleteMyAccount(client, email);
      if (result.ok) {
        setAppleLeft(apple.kind === "not-revoked");
        setDone(result.data);
        return;
      }
      const error = result.error;
      setProblem(
        error.kind === "refusal"
          ? { title: t("compass.account.refusedTitle"), message: error.message }
          : {
              message: t("compass.account.failed", {
                reason: "message" in error ? error.message : error.kind,
              }),
            },
      );
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setProblem(null);
    try {
      await store?.wipe();
      // The sign-in no longer exists on the server; forget the session on this device only.
      await client.auth.signOut({ scope: "local" });
    } catch (error: unknown) {
      setProblem({
        message: t("compass.account.signOutFailed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };

  if (done) {
    return (
      <Screen testID="account-deleted" title={t("compass.account.doneTitle")}>
        <Card>
          <Text>{t("compass.account.doneSentence", { count: done.orgsNotified })}</Text>
        </Card>
        <KeptList categories={done.kept.map((k) => k.category)} />
        {appleLeft ? (
          <InlineAlert
            testID="account-apple-not-revoked"
            tone="info"
            message={t("compass.account.appleNotRevoked")}
          />
        ) : null}
        {problem ? <InlineAlert tone="danger" message={problem.message} /> : null}
        <Button
          testID="account-deleted-done"
          label={t("compass.account.done")}
          block
          onPress={() => void finish()}
        />
      </Screen>
    );
  }

  // The hold on Delete Account comes straight after typing the email. Without "handled" the first touch
  // only closed the keyboard, and the hold never reached the button (A68, journey 38).
  return (
    <Screen testID="account" title={t("compass.account.title")} keyboardShouldPersistTaps="handled">
      <Text tone="secondary">{t("compass.account.intro")}</Text>
      {!network.isConnected ? (
        <InlineAlert
          testID="account-offline"
          tone="warning"
          message={t("compass.account.offline")}
        />
      ) : load.kind === "loading" ? (
        <Skeleton testID="account-loading" height={20} lines={4} />
      ) : load.kind === "failed" ? (
        <ErrorState
          testID="account-error"
          title={t("compass.account.previewFailedTitle")}
          sentence={t("compass.account.previewFailed", { reason: load.reason })}
          actionLabel={t("compass.account.retry")}
          onRetry={() => void check()}
        />
      ) : load.preview.blockers.length > 0 ? (
        <>
          <Text variant="heading16" heading>
            {t("compass.account.blockersTitle")}
          </Text>
          {load.preview.blockers.map((b) => (
            <RefusalNotice
              key={`${b.code}-${b.orgId}`}
              testID={`account-blocker-${b.code}`}
              outcome="REFUSE"
              title={b.orgName}
              reason={t(`compass.account.blocker.${b.code}`, {
                org: b.orgName,
                matter: b.matter ?? "",
              })}
              actionLabel={t("compass.account.retry")}
              onAction={() => void check()}
            />
          ))}
          <KeptList categories={load.preview.kept.map((k) => k.category)} />
        </>
      ) : (
        <>
          <KeptList categories={load.preview.kept.map((k) => k.category)} />
          <Card>
            <TextField
              testID="account-email"
              label={t("compass.account.emailLabel")}
              help={t("compass.account.emailHelp", { email: load.preview.email })}
              keyboard="email"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              {...(email.includes("@") &&
              email.trim().length >= load.preview.email.length &&
              email.trim().toLowerCase() !== load.preview.email
                ? { error: t("compass.account.emailMismatch") }
                : {})}
            />
          </Card>
          {problem ? (
            problem.title ? (
              <RefusalNotice
                testID="account-refused"
                outcome="REFUSE"
                title={problem.title}
                reason={problem.message}
              />
            ) : (
              <InlineAlert testID="account-problem" tone="danger" message={problem.message} />
            )
          ) : null}
          <Button
            testID="account-delete"
            variant="danger"
            icon="ban"
            block
            holdToConfirm={{ seconds: 2, hint: t("compass.account.deleteHoldHint") }}
            loading={busy}
            disabled={busy || email.trim().toLowerCase() !== load.preview.email}
            label={t("compass.account.delete")}
            onPress={() => void remove()}
          />
        </>
      )}
    </Screen>
  );
}

function KeptList({ categories }: { readonly categories: readonly string[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <Card title={t("compass.account.keptTitle")} testID="account-kept">
      {categories.map((c) => (
        <Text key={c} variant="text13" tone="secondary">
          {t(`compass.account.kept.${c}`)}
        </Text>
      ))}
    </Card>
  );
}
