import type { Row } from "@xos/sync";
import { uuidv7 } from "@xos/sync";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import {
  afterPin,
  afterServer,
  backspace,
  buildKioskPunch,
  canSubmitPin,
  forgetKiosk,
  KIOSK_RESET_MS,
  KIOSK_START,
  hasQueuedPunch,
  kioskPhotoPath,
  kioskPunchKind,
  kioskWarmer,
  learnShift,
  pickWorker,
  pressDigit,
  rosterWithKnowledge,
  searchRoster,
  singleFlight,
  submitKioskPunch,
  type KioskStep,
  type RosterEntry,
  type ShiftKnowledge,
} from "../src/domain/kiosk";
import { kioskRules, soundsOn } from "../src/domain/settings";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import { fieldMediaUploader, processPhoto, wantsExif } from "../src/runtime/media";
import { countKey } from "../src/runtime/i18n";
import { deviceClock } from "../src/runtime/platform";

import { Gate, useAllowed } from "../src/screens/common";
import { NativeHeaderProvider } from "../src/ui/layout";
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
  "request-invalid": "compass.kiosk.refused.requestInvalid",
  "kiosk-disabled": "compass.kiosk.refused.kioskDisabled",
  "photo-required": "compass.kiosk.refused.photoRequired",
  "already-in": "compass.kiosk.refused.alreadyIn",
  "not-in": "compass.kiosk.refused.notIn",
  "rate-limited": "compass.kiosk.refused.rateLimited",
  "punch-refused": "compass.kiosk.refused.punchRefused",
} as const;

/**
 * The device key names no live kiosk (retired or revoked in Atlas, migration 1420). The kiosk takes no
 * PINs; a supervisor who is still signed in can forget the key, which returns to kiosk setup (A85).
 */
function Unregistered({
  supervisor,
  onForget,
}: {
  readonly supervisor: boolean;
  readonly onForget: () => Promise<"forgotten" | "supervisor-required">;
}): ReactElement {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(!supervisor);
  const forget = async () => {
    setBusy(true);
    const outcome = await onForget();
    setBusy(false);
    setConfirming(false);
    setRefused(outcome === "supervisor-required");
  };
  return (
    <Card testID="kiosk-unregistered" title={t("compass.kiosk.unregistered.title")}>
      <Text tone="secondary">{t("compass.kiosk.unregistered.sentence")}</Text>
      {refused ? (
        <InlineAlert
          testID="kiosk-forget-refused"
          tone="warning"
          message={t("compass.kiosk.unregistered.supervisorRequired")}
        />
      ) : null}
      {supervisor && !confirming ? (
        <Button
          testID="kiosk-forget"
          variant="secondary"
          block
          label={t("compass.kiosk.unregistered.forget")}
          onPress={() => setConfirming(true)}
        />
      ) : null}
      {supervisor && confirming ? (
        <InlineAlert
          tone="warning"
          title={t("compass.kiosk.unregistered.confirmTitle")}
          message={t("compass.kiosk.unregistered.confirmSentence")}
        />
      ) : null}
      {supervisor && confirming ? (
        <Button
          testID="kiosk-forget-confirm"
          variant="danger"
          block
          loading={busy}
          disabled={busy}
          label={t("compass.kiosk.unregistered.confirm")}
          onPress={() => void forget()}
        />
      ) : null}
      {supervisor && confirming ? (
        <Button
          testID="kiosk-forget-cancel"
          variant="ghost"
          block
          label={t("compass.common.cancel")}
          onPress={() => setConfirming(false)}
        />
      ) : null}
    </Card>
  );
}

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
  sending,
  onStep,
  onSubmit,
}: {
  readonly step: KioskStep;
  /** A punch is on its way: the keypad and the button take no taps until its outcome shows. */
  readonly sending: boolean;
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
              disabled={sending}
              accessibilityRole="button"
              accessibilityState={{ disabled: sending }}
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
        loading={sending}
        disabled={sending || !canSubmitPin(step)}
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
  const {
    settings,
    updateSettings,
    projectId,
    config,
    client,
    engine,
    status,
    orgSettings,
    resolved,
  } = useCompass();
  // time.kiosk_enabled and time.photo_on_punch for this project (migration 1321).
  const rules = kioskRules(orgSettings);
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing] = useState(false);
  const theme = useTheme();
  const [step, setStep] = useState<KioskStep>(KIOSK_START);
  const [query, setQuery] = useState("");
  const { rows: roster } = useRows<Row & { display_name: string }>("kiosk_roster");
  const { rows: open } = useRows<Row & { membership_id?: string | null; clock_out: string | null }>(
    "time_entries",
    (e) => e.clock_out === null,
  );
  const supervisor = useAllowed("kiosk.operate");
  // One punch at a time: a second tap while a punch is on its way builds no second punch.
  const flight = useRef(singleFlight()).current;
  const [sending, setSending] = useState(false);
  // Who this kiosk just clocked in or out, until the synced time entries say the same.
  const [known, setKnown] = useState<ShiftKnowledge>({});
  const functionUrl = `${config.supabaseUrl}/functions/v1/kiosk-punch`;
  // Wakes the function while the worker types the PIN, so the punch meets a started worker.
  const warm = useMemo(
    () => kioskWarmer(() => fetch(functionUrl, { method: "GET" })),
    [functionUrl],
  );
  useEffect(() => {
    if (step.kind !== "done" && step.kind !== "refused") return undefined;
    const timer = setTimeout(() => setStep(KIOSK_START), KIOSK_RESET_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const current = rosterWithKnowledge(
    roster.map((r) => ({
      membershipId: r.id,
      displayName: r.display_name,
      onShift: open.some((e) => e.membership_id === r.id),
    })),
    known,
    Date.now(),
  );
  const entries: RosterEntry[] = current.roster;
  // What the synced rows now agree with is forgotten, so a later change made elsewhere is believed.
  const settled = current.known;
  useEffect(() => {
    if (settled !== known) setKnown(settled);
  }, [settled, known]);
  if (!settings.kioskDeviceKey)
    return <Setup onKey={(key) => updateSettings({ kioskDeviceKey: key })} />;
  const submit = (photo: { path: string; localUri: string } | null = null) =>
    flight.run(async () => {
      if ((step.kind !== "pin" && step.kind !== "photo") || !engine || !settings.kioskDeviceKey)
        return;
      setSending(true);
      try {
        // The punch and its id are built once per tap. Every send of it, now or from the queue, carries
        // this id, so the server records it once (app.record_punch).
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
            photo,
          },
          Date.now(),
        );
        const outcome = await submitKioskPunch(input, {
          online: status?.online === true,
          enqueue: (punch) => engine.outbox.enqueue(punch),
          queuedAhead: async () =>
            hasQueuedPunch(await engine.outbox.all(), step.worker.membershipId),
          ...(photo
            ? {
                storePhoto: async () => {
                  const stored = await fieldMediaUploader(client)(photo.path, photo.localUri);
                  return !stored.error || stored.error.statusCode === "409";
                },
              }
            : {}),
          post: async (body, signal) => {
            const token = (await client.auth.getSession()).data.session?.access_token;
            return fetch(functionUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(body),
              signal,
            });
          },
        });
        if (outcome.ok === true)
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (outcome.ok === false)
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setKnown((k) =>
          learnShift(k, step.worker.membershipId, kioskPunchKind(step.worker), outcome, Date.now()),
        );
        // The outcome belongs to the step it was sent from, and shows only while that step is on screen.
        setStep((now) => (now === step ? afterServer(step, outcome) : now));
      } finally {
        setSending(false);
      }
    });
  const forget = async () => {
    const outcome = await forgetKiosk({
      supervisor,
      // The auth server confirms the session now; a cached or expired one does not count.
      verifiedUserId: async () => {
        const { data, error } = await client.auth.getUser();
        return error ? null : (data.user?.id ?? null);
      },
      clearKey: () => updateSettings({ kioskDeviceKey: null }),
    });
    if (outcome === "forgotten") setStep(KIOSK_START);
    return outcome;
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
      {!rules.enabled ? (
        <InlineAlert testID="kiosk-off" tone="warning" message={t("compass.kiosk.off")} />
      ) : null}
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
                  onPress={() => {
                    warm();
                    setStep(pickWorker(w));
                  }}
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
          <PinPad
            step={step}
            sending={sending}
            onStep={setStep}
            onSubmit={() => {
              // Photo on punch: the PIN leads to the camera first.
              if (rules.photoOnPunch) setStep(afterPin(step, true));
              else void submit();
            }}
          />
          <Button
            variant="ghost"
            disabled={sending}
            label={t("compass.common.back")}
            onPress={() => setStep(KIOSK_START)}
          />
        </Card>
      ) : null}
      {step.kind === "photo" ? (
        <Card title={t("compass.kiosk.photoFor", { name: step.worker.displayName })}>
          <Text tone="secondary">{t("compass.kiosk.photoHelp")}</Text>
          {permission?.granted ? (
            <View
              style={{
                height: theme.space["64"] * 5,
                borderRadius: theme.radius.card,
                overflow: "hidden",
              }}
            >
              <CameraView ref={camera} style={{ flex: 1 }} facing="front" />
            </View>
          ) : (
            <Button
              label={t("compass.scan.allowCamera")}
              onPress={() => void requestPermission()}
            />
          )}
          <Button
            testID="kiosk-photo-take"
            size="lg"
            block
            icon="camera"
            loading={capturing}
            disabled={capturing || !permission?.granted || !projectId || !resolved?.orgId}
            label={t("compass.photo.take")}
            onPress={() =>
              void (async () => {
                if (capturing || !camera.current || !projectId || !resolved?.orgId) return;
                setCapturing(true);
                try {
                  const shot = await camera.current.takePictureAsync({
                    exif: wantsExif(orgSettings),
                    quality: 0.8,
                    shutterSound: soundsOn(orgSettings),
                  });
                  const localUri = await processPhoto(shot.uri, shot.width, shot.height, {
                    settings: orgSettings,
                    exif: shot.exif as Record<string, unknown> | undefined,
                  });
                  await submit({
                    path: kioskPhotoPath(resolved.orgId, projectId, uuidv7(Date.now())),
                    localUri,
                  });
                } finally {
                  setCapturing(false);
                }
              })()
            }
          />
          <Button
            variant="ghost"
            disabled={sending}
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
      {step.kind === "unregistered" ? (
        <Unregistered supervisor={supervisor} onForget={forget} />
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

/** The kiosk hides the stack header, so its screens draw their own title (finding A59-031). */
export default function KioskScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <NativeHeaderProvider value={false}>
      <Gate feature="kiosk.operate" title={t("compass.kiosk.title")}>
        <Kiosk />
      </Gate>
    </NativeHeaderProvider>
  );
}
