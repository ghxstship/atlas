/**
 * Recovery codes, passkeys, and sessions and devices on Settings, Security (A99, 1560 and 1561; ADR 0070). Like the
 * rest of Security, each needs the server's answer, so offline the controls are disabled.
 */
import {
  deviceName,
  generateRecoveryCodes,
  signOutOtherSessions,
  signOutSession,
  type SignedInSession,
} from "@xos/data/account-security";
import { removePasskey, renamePasskey, type Passkey } from "@xos/data/auth-assurance";
import type { XosClient } from "@xos/data/client";
import type { TFunction } from "i18next";
import * as Linking from "expo-linking";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Share, View } from "react-native";
import { useCompass } from "../../runtime/CompassProvider";
import { countKey } from "../../runtime/i18n";
import { gatewaySectionUrl } from "../../settings/sections";
import {
  isStepUpRefusal,
  recoveryCodesText,
  securityErrorKey,
  STEP_UP,
} from "../../settings/security";
import { Button, Card, InlineAlert, ListRow, Skeleton, Tag, Text } from "../../ui";
import { ConfirmSheet } from "./parts";
import { holdsFactor, RenameSheet, useDate, type SecurityData } from "./SecurityCards";
import type { StepUp } from "./StepUp";

const A = "authSecurity";
const S = "compassSettings.security";

// Passkeys -------------------------------------------------------------------------------------------------------------

/** Passkeys: listed, renamed and removed here; added in Gateway, since a passkey belongs to a web address. */
export function PasskeysCard({
  data,
  stepUp,
}: {
  readonly data: SecurityData;
  readonly stepUp: StepUp;
}): ReactElement {
  const { t } = useTranslation();
  const { client, network, config } = useCompass();
  const db = client as unknown as XosClient;
  const { date } = useDate();
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offline = !network.isConnected;
  const name = (p: Passkey) => p.label || t(`${A}.passkeys.labelDefault`);

  const remove = async (passkey: Passkey): Promise<void> => {
    setError(null);
    const removed = await removePasskey(db, passkey.id);
    if (!removed.ok) {
      if (isStepUpRefusal(removed.error)) stepUp.require(() => remove(passkey));
      else setError(t(securityErrorKey(removed.error)));
      return;
    }
    data.reload();
  };

  return (
    <Card testID="settings-security-passkeys" title={t(`${A}.passkeys.title`)}>
      <Text variant="text13" tone="tertiary">
        {t(`${A}.passkeys.description`)}
      </Text>
      {data.passkeys === null && !offline ? (
        <Skeleton lines={1} />
      ) : data.passkeys === "failed" ? (
        <InlineAlert tone="danger" message={t(`${A}.errors.unexpected`)} />
      ) : !Array.isArray(data.passkeys) || data.passkeys.length === 0 ? (
        <Text tone="secondary">{t(`${A}.passkeys.none`)}</Text>
      ) : (
        data.passkeys.map((p) => (
          <ListRow
            key={p.id}
            testID="settings-security-passkey"
            title={name(p)}
            subtitle={`${t(`${A}.passkeys.added`, { date: date(p.createdAt) })} · ${
              p.lastUsedAt
                ? t(`${A}.passkeys.lastUsed`, { date: date(p.lastUsedAt) })
                : t(`${A}.passkeys.neverUsed`)
            }`}
            trailing={
              <View style={{ alignItems: "flex-end" }}>
                <Button
                  testID="settings-security-passkey-rename"
                  variant="ghost"
                  label={t(`${A}.passkeys.rename`)}
                  disabled={offline}
                  onPress={() => setRenaming(p)}
                />
                <Button
                  testID="settings-security-passkey-remove"
                  variant="ghost"
                  label={t(`${A}.passkeys.remove`)}
                  disabled={offline}
                  onPress={() => {
                    setError(null);
                    setRemoving(p);
                  }}
                />
              </View>
            }
          />
        ))
      )}
      {error ? (
        <InlineAlert testID="settings-security-passkeys-error" tone="danger" message={error} />
      ) : null}
      <ListRow
        testID="settings-security-passkeys-gateway"
        icon="external-link"
        title={t(`${A}.passkeys.add`)}
        subtitle={t(`${S}.passkeysInGateway`)}
        onPress={() =>
          void Linking.openURL(gatewaySectionUrl(config.gatewayUrl, "/settings/security"))
        }
      />
      <RenameSheet
        target={renaming ? { name: name(renaming) } : null}
        onClose={() => setRenaming(null)}
        onSave={async (label) => {
          if (!renaming) return null;
          const renamed = await renamePasskey(db, renaming.id, label);
          if (!renamed.ok) return securityErrorKey(renamed.error);
          data.reload();
          return null;
        }}
      />
      <ConfirmSheet
        testID="settings-security-passkey-remove-confirm"
        open={removing !== null}
        title={t(`${A}.passkeys.removeTitle`, { name: removing ? name(removing) : "" })}
        sentence={t(`${A}.passkeys.removeSentence`)}
        confirmLabel={t(`${A}.passkeys.remove`)}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          // The confirmation closes before any step-up sheet opens: iOS shows one sheet at a time.
          const passkey = removing;
          setRemoving(null);
          if (passkey) {
            void stepUp.guard(STEP_UP["removePasskey"] ?? "if-factor", holdsFactor(data), () =>
              remove(passkey),
            );
          }
        }}
      />
    </Card>
  );
}

// Recovery codes ---------------------------------------------------------------------------------------------------------

/**
 * Recovery codes (A99, 1560): how many are left, and a new set after step-up, shown once with Share so the person
 * saves them in a password manager or notes. Making a set replaces the old one.
 */
export function RecoveryCard({
  data,
  stepUp,
}: {
  readonly data: SecurityData;
  readonly stepUp: StepUp;
}): ReactElement {
  const { t } = useTranslation();
  const { client, network } = useCompass();
  const db = client as unknown as XosClient;
  const { date, dateTime } = useDate();
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = !network.isConnected;
  const status = data.codes;

  const make = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const made = await generateRecoveryCodes(db);
    setBusy(false);
    if (!made.ok) {
      if (isStepUpRefusal(made.error)) stepUp.require(make);
      else setError(t(securityErrorKey(made.error)));
      return;
    }
    setCodes(made.data);
  };

  return (
    <Card testID="settings-security-recovery" title={t(`${A}.recovery.title`)}>
      <Text variant="text13" tone="tertiary">
        {t(`${A}.recovery.description`)}
      </Text>
      {codes ? (
        <>
          <InlineAlert tone="warning" message={t(`${A}.recovery.shownOnce`)} />
          <View accessible accessibilityLabel={t(`${A}.recovery.listLabel`)}>
            {codes.map((c) => (
              <Text key={c} testID="settings-security-recovery-code">
                {c}
              </Text>
            ))}
          </View>
          <Button
            testID="settings-security-recovery-share"
            variant="secondary"
            icon="copy"
            block
            label={t(`${S}.shareCodes`)}
            onPress={() =>
              void Share.share({
                message: recoveryCodesText(
                  codes,
                  t(`${A}.recovery.fileHeading`),
                  t(`${A}.recovery.fileNote`, { date: date(new Date().toISOString()) }),
                ),
              }).catch(() => undefined)
            }
          />
          <Button
            testID="settings-security-recovery-saved"
            block
            label={t(`${A}.recovery.done`)}
            onPress={() => {
              setCodes(null);
              data.reload();
            }}
          />
        </>
      ) : status === null && !offline ? (
        <Skeleton lines={1} />
      ) : status === "failed" ? (
        <InlineAlert tone="danger" message={t(`${A}.errors.unexpected`)} />
      ) : !holdsFactor(data) ? (
        <Text testID="settings-security-recovery-need-factor" tone="secondary">
          {t(`${A}.recovery.needFactor`)}
        </Text>
      ) : (
        <>
          {status === null ? null : status.total === 0 ? (
            <Text tone="secondary">{t(`${A}.recovery.none`)}</Text>
          ) : (
            <>
              <Text testID="settings-security-recovery-status">
                {t(`${A}.recovery.status`, {
                  remaining: status.remaining,
                  total: status.total,
                  date: status.createdAt ? date(status.createdAt) : "",
                })}
              </Text>
              {status.lastUsedAt ? (
                <Text variant="text13" tone="tertiary">
                  {t(`${A}.recovery.lastUsed`, { date: dateTime(status.lastUsedAt) })}
                </Text>
              ) : null}
              {status.remaining === 0 ? (
                <InlineAlert tone="warning" message={t(`${A}.recovery.noneLeft`)} />
              ) : status.remaining <= 3 ? (
                <InlineAlert
                  tone="warning"
                  message={t(countKey(`${S}.recoveryLow`, status.remaining), {
                    count: status.remaining,
                  })}
                />
              ) : null}
            </>
          )}
          {error ? (
            <InlineAlert testID="settings-security-recovery-error" tone="danger" message={error} />
          ) : null}
          <Button
            testID="settings-security-recovery-make"
            variant="secondary"
            loading={busy}
            label={t(
              status !== null && status.total > 0
                ? `${A}.recovery.regenerate`
                : `${A}.recovery.generate`,
            )}
            disabled={offline}
            onPress={() => {
              setError(null);
              setConfirming(true);
            }}
          />
        </>
      )}
      <ConfirmSheet
        testID="settings-security-recovery-confirm"
        open={confirming}
        title={t(`${A}.recovery.regenerateTitle`)}
        sentence={t(`${A}.recovery.regenerateSentence`)}
        confirmLabel={t(`${A}.recovery.regenerate`)}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          // The confirmation closes before any step-up sheet opens: iOS shows one sheet at a time.
          setConfirming(false);
          void stepUp.guard(STEP_UP["makeRecoveryCodes"] ?? "always", holdsFactor(data), make);
        }}
      />
    </Card>
  );
}

// Sessions -------------------------------------------------------------------------------------------------------------

function deviceLabel(t: TFunction, s: SignedInSession): string {
  if (!s.userAgent) return t(`${A}.sessions.unknownDevice`);
  const device = deviceName(s.userAgent);
  return t(`${A}.sessions.device`, {
    browser: t(`${A}.sessions.browsers.${device.browser}`),
    os: t(`${A}.sessions.systems.${device.os}`),
  });
}

/** Sessions and devices (A99, 1561): where the person is signed in, signing out one or every other. */
export function SessionsCard({ data }: { readonly data: SecurityData }): ReactElement {
  const { t } = useTranslation();
  const { client, network } = useCompass();
  const db = client as unknown as XosClient;
  const { dateTime } = useDate();
  const [ending, setEnding] = useState<SignedInSession | "others" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const offline = !network.isConnected;
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  const end = async () => {
    if (!ending) return;
    setBusy(true);
    setError(null);
    if (ending === "others") {
      const ended = await signOutOtherSessions(db);
      setBusy(false);
      if (!ended.ok) {
        setError(t(securityErrorKey(ended.error)));
        return;
      }
      setNotice(
        ended.data === 0
          ? t(`${S}.signedOutOthersNone`)
          : t(countKey(`${S}.signedOutOthers`, ended.data), { count: ended.data }),
      );
    } else {
      const ended = await signOutSession(db, ending.id);
      setBusy(false);
      if (!ended.ok) {
        setError(t(securityErrorKey(ended.error)));
        return;
      }
      setNotice(t(`${A}.sessions.signedOut`));
    }
    setEnding(null);
    data.reload();
  };

  return (
    <Card testID="settings-security-sessions" title={t(`${A}.sessions.title`)}>
      <Text variant="text13" tone="tertiary">
        {t(`${A}.sessions.description`)}
      </Text>
      {data.sessions === null && !offline ? (
        <Skeleton lines={2} />
      ) : data.sessions === "failed" ? (
        <InlineAlert tone="danger" message={t(`${A}.errors.unexpected`)} />
      ) : (
        sessions.map((s) => {
          const device = deviceLabel(t, s);
          const where = s.place
            ? t(`${A}.sessions.place`, { place: s.place })
            : s.clientAddress
              ? t(`${A}.sessions.address`, { address: s.clientAddress })
              : null;
          return (
            <ListRow
              key={s.id}
              testID={s.current ? "settings-security-session-current" : "settings-security-session"}
              title={device}
              subtitle={[
                s.surface ? t(`${A}.sessions.surfaces.${s.surface}`) : null,
                where,
                t(`${A}.sessions.lastActive`, { date: dateTime(s.lastActiveAt) }),
              ]
                .filter(Boolean)
                .join(" · ")}
              trailing={
                s.current ? (
                  <Tag tone="accent" label={t(`${A}.sessions.thisDevice`)} />
                ) : (
                  <Button
                    testID="settings-security-session-sign-out"
                    variant="ghost"
                    label={t(`${A}.sessions.signOut`)}
                    disabled={offline}
                    onPress={() => {
                      setError(null);
                      setEnding(s);
                    }}
                  />
                )
              }
            />
          );
        })
      )}
      {notice ? (
        <InlineAlert testID="settings-security-sessions-notice" tone="success" message={notice} />
      ) : null}
      {sessions.some((s) => !s.current) ? (
        <Button
          testID="settings-security-sessions-others"
          variant="secondary"
          label={t(`${A}.sessions.signOutOthers`)}
          disabled={offline}
          onPress={() => {
            setError(null);
            setEnding("others");
          }}
        />
      ) : Array.isArray(data.sessions) ? (
        <Text tone="secondary">{t(`${A}.sessions.none`)}</Text>
      ) : null}
      <ConfirmSheet
        testID="settings-security-session-confirm"
        open={ending !== null}
        title={
          ending === "others"
            ? t(`${A}.sessions.signOutOthersTitle`)
            : t(`${A}.sessions.signOutTitle`, { device: ending ? deviceLabel(t, ending) : "" })
        }
        sentence={
          ending === "others"
            ? t(`${A}.sessions.signOutOthersSentence`)
            : t(`${A}.sessions.signOutSentence`)
        }
        confirmLabel={
          ending === "others" ? t(`${A}.sessions.signOutOthers`) : t(`${A}.sessions.signOut`)
        }
        danger
        busy={busy}
        error={error}
        onClose={() => setEnding(null)}
        onConfirm={() => void end()}
      />
    </Card>
  );
}
