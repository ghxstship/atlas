import type { Row } from "@xos/sync";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import {
  afterServer,
  backspace,
  buildKioskPunch,
  canSubmitPin,
  KIOSK_RESET_MS,
  KIOSK_START,
  kioskPunchKind,
  pickWorker,
  pressDigit,
  searchRoster,
  type KioskStep,
  type RosterEntry,
} from "../src/domain/kiosk";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import { countKey } from "../src/runtime/i18n";
import { deviceClock } from "../src/runtime/platform";

import { Gate } from "../src/screens/common";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  ListRow,
  RefusalNotice,
  Screen,
  Text,
  TextField,
  useTheme,
} from "../src/ui";

const REFUSED_KEY = {
  "pin-locked": "compass.kiosk.refused.pinLocked",
  "pin-invalid": "compass.kiosk.refused.pinLocked",
  "device-revoked": "compass.kiosk.refused.deviceRevoked",
  "request-invalid": "compass.kiosk.refused.requestInvalid",
} as const;

function Setup({ onKey }: { readonly onKey: (key: string) => void }): ReactElement {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const valid = /^xkio_[0-9a-f]{64}$/.test(key.trim());
  return (
    <Screen testID="kiosk-setup" title={t("compass.kiosk.setupTitle")}>
      <Text tone="secondary">{t("compass.kiosk.setupSentence")}</Text>
      <TextField
        testID="kiosk-key"
        label={t("compass.kiosk.deviceKey")}
        value={key}
        onChangeText={setKey}
        secure
        {...(key.length > 5 && !valid ? { error: t("compass.kiosk.deviceKeyInvalid") } : {})}
      />
      <Button
        testID="kiosk-start"
        size="lg"
        block
        disabled={!valid}
        label={t("compass.kiosk.startKiosk")}
        onPress={() => onKey(key.trim())}
      />
    </Screen>
  );
}

function PinPad({
  step,
  onStep,
  onSubmit,
}: {
  readonly step: KioskStep;
  readonly onStep: (s: KioskStep) => void;
  readonly onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
  const digits = step.kind === "pin" ? step.digits.length : 0;
  return (
    <View style={{ gap: theme.space["16"] }}>
      {/* The dots read as "bullet bullet" (A23-010), so assistive technology hears the count. */}
      <View
        accessible
        accessibilityLabel={t(countKey("compass.kiosk.pinProgress", digits), { count: digits })}
        testID="kiosk-pin-progress"
      >
        <Text variant="heading32" testID="kiosk-pin-dots">
          {"•".repeat(digits) || " "}
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["12"] }}>
        {keys.map((k, i) =>
          k === "" ? (
            // A string key of its own: the index 9 collided with the "9" key and React dropped a key.
            <View key={`gap-${i}`} style={{ width: "30%" }} />
          ) : (
            <Pressable
              key={k}
              testID={`kiosk-key-${k}`}
              accessibilityRole="button"
              accessibilityLabel={
                k === "del" ? t("compass.kiosk.backspace") : t("compass.kiosk.digit", { digit: k })
              }
              onPress={() => {
                void Haptics.selectionAsync();
                onStep(k === "del" ? backspace(step) : pressDigit(step, k));
              }}
              style={{
                width: "30%",
                minHeight: theme.space["64"],
                borderRadius: theme.radius.dialog,
                backgroundColor: theme.color.bgRaised,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text variant="heading24">{k === "del" ? "⌫" : k}</Text>
            </Pressable>
          ),
        )}
      </View>
      <Button
        testID="kiosk-submit"
        size="lg"
        block
        disabled={!canSubmitPin(step)}
        label={
          step.kind === "pin" && kioskPunchKind(step.worker) === "Out"
            ? t("compass.kiosk.punchOut")
            : t("compass.kiosk.punchIn")
        }
        onPress={onSubmit}
      />
    </View>
  );
}

/**
 * Kiosk mode (Section 4.3 item 2, Section 13): a shared device where workers punch with a PIN. The PIN is
 * checked only by the server through the kiosk-punch Edge Function; offline punches queue and are checked
 * on upload, and the screen says so.
 */
function Kiosk(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { settings, updateSettings, projectId, config, client, engine, status } = useCompass();
  const [step, setStep] = useState<KioskStep>(KIOSK_START);
  const [query, setQuery] = useState("");
  const { rows: roster } = useRows<Row & { display_name: string }>("kiosk_roster");
  const { rows: open } = useRows<Row & { membership_id?: string | null; clock_out: string | null }>(
    "time_entries",
    (e) => e.clock_out === null,
  );
  useEffect(() => {
    if (step.kind !== "done" && step.kind !== "refused") return undefined;
    const timer = setTimeout(() => setStep(KIOSK_START), KIOSK_RESET_MS);
    return () => clearTimeout(timer);
  }, [step]);
  if (!settings.kioskDeviceKey)
    return <Setup onKey={(key) => updateSettings({ kioskDeviceKey: key })} />;
  const entries: RosterEntry[] = roster.map((r) => ({
    membershipId: r.id,
    displayName: r.display_name,
    onShift: open.some((e) => e.membership_id === r.id),
  }));
  const submit = async () => {
    if (step.kind !== "pin" || !engine || !settings.kioskDeviceKey) return;
    const input = buildKioskPunch(
      {
        deviceKey: settings.kioskDeviceKey,
        projectId,
        worker: step.worker,
        pin: step.digits,
        deviceAt: new Date().toISOString(),
        monotonicAt: deviceClock.monotonicNow(),
        bootId: deviceClock.bootId(),
        photoUri: null,
      },
      Date.now(),
    );
    if (!status?.online) {
      await engine.outbox.enqueue(input);
      setStep(afterServer(step, { ok: "queued" }));
      return;
    }
    const token = (await client.auth.getSession()).data.session?.access_token;
    try {
      const response = await fetch(`${config.supabaseUrl}/functions/v1/kiosk-punch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...input.payload, monotonicOffsetMs: 0 }),
      });
      if (response.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setStep(afterServer(step, { ok: true }));
        return;
      }
      const body = (await response.json()) as { reason?: string };
      if (response.status === 422) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setStep(afterServer(step, { ok: false, reason: body.reason ?? "kiosk_request_invalid" }));
        return;
      }
      await engine.outbox.enqueue(input);
      setStep(afterServer(step, { ok: "queued" }));
    } catch {
      // The network dropped mid-request: the punch queues with its id, so a retry cannot double it.
      await engine.outbox.enqueue(input);
      setStep(afterServer(step, { ok: "queued" }));
    }
  };
  return (
    <Screen
      testID="kiosk"
      title={t("compass.kiosk.title")}
      footer={
        <Button
          testID="kiosk-exit"
          variant="ghost"
          label={t("compass.kiosk.exit")}
          onPress={() => router.replace("/more")}
        />
      }
    >
      {step.kind === "pick" ? (
        <>
          <Text variant="heading24" heading>
            {t("compass.kiosk.pick")}
          </Text>
          <TextField
            testID="kiosk-search"
            label={t("compass.kiosk.search")}
            value={query}
            onChangeText={setQuery}
            autoComplete="name"
          />
          {searchRoster(entries, query).length === 0 ? (
            <EmptyState
              icon="users"
              sentence={t("compass.kiosk.noMatch")}
              actionLabel={t("compass.common.retry")}
              onAction={() => setQuery("")}
            />
          ) : (
            searchRoster(entries, query)
              .slice(0, 20)
              .map((w) => (
                <ListRow
                  key={w.membershipId}
                  testID={`kiosk-worker-${w.membershipId}`}
                  icon="user"
                  title={w.displayName}
                  onPress={() => setStep(pickWorker(w))}
                />
              ))
          )}
        </>
      ) : null}
      {step.kind === "pin" ? (
        <Card title={t("compass.kiosk.pinFor", { name: step.worker.displayName })}>
          <Text tone="secondary">
            {step.attemptsLeft < 5
              ? t("compass.kiosk.attemptsLeft", { count: step.attemptsLeft })
              : t("compass.kiosk.pinHelp")}
          </Text>
          <PinPad step={step} onStep={setStep} onSubmit={() => void submit()} />
          <Button
            variant="ghost"
            label={t("compass.common.back")}
            onPress={() => setStep(KIOSK_START)}
          />
        </Card>
      ) : null}
      {step.kind === "done" ? (
        <InlineAlert
          testID="kiosk-done"
          tone={step.verified ? "success" : "warning"}
          message={
            step.verified
              ? t(step.punch === "Out" ? "compass.kiosk.doneOut" : "compass.kiosk.doneIn", {
                  name: step.worker.displayName,
                })
              : t("compass.kiosk.doneQueued", { name: step.worker.displayName })
          }
        />
      ) : null}
      {step.kind === "refused" ? (
        <RefusalNotice
          testID="kiosk-refused"
          outcome="REFUSE"
          title={step.worker.displayName}
          reason={t(REFUSED_KEY[step.reason])}
          actionLabel={t("compass.common.done")}
          onAction={() => setStep(KIOSK_START)}
        />
      ) : null}
    </Screen>
  );
}

export default function KioskScreen(): ReactElement {
  return (
    <Gate feature="kiosk.operate">
      <Kiosk />
    </Gate>
  );
}
