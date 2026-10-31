import type { Row } from "@xos/sync";
import * as Brightness from "expo-brightness";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, View } from "react-native";
import {
  access,
  operationalEngagements,
  scanModes,
  type ScanMode,
  type ScanModeGrant,
} from "../../src/domain/access";
import { zoneCountsLive, zoneTotals } from "@xos/data/credentials";
import type { XosClient } from "@xos/data/client";
import {
  addScannedTag,
  buildAccessScan,
  buildScanOverride,
  canOverride,
  assetScanAction,
  buildAssetScan,
  buildIntake,
  classify,
  ContinuousScan,
  custodyBlocked,
  decideGate,
  gateScanTitle,
  resolveAsset,
  type AccessGridRow,
  type AssetIdentifierRow,
  type AssetUnitRow,
  type CredentialRow,
  type CustodyRow,
  type ReceiveSheet,
  type ScanDirection,
  type Symbology,
} from "../../src/domain/scan";
import { useProjectCapabilities } from "../../src/domain/project-capabilities";
import { scanAnnouncement } from "../../src/domain/announce";
import { hapticsOn } from "../../src/domain/settings";
import { codeFromTag, encodeTextMessage } from "../../src/domain/nfc";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { nfc } from "../../src/runtime/nfc";
import { DenialNotice, formatDay, ProjectPicker, SyncBanner } from "../../src/screens/common";
import { FakeNfcSheet, useNfcAvailability } from "../../src/screens/NfcControls";
import { ReceiveOrderSheet } from "../../src/screens/ReceiveOrderSheet";
import { Scanner } from "../../src/screens/Scanner";
import { WalletButton } from "../../src/screens/WalletButton";
import {
  announce,
  Button,
  Card,
  CredentialBadge,
  EmptyState,
  IconButton,
  ListRow,
  ScanSheet,
  Screen,
  SegmentedControl,
  Sheet,
  Text,
  TextField,
  useTheme,
  type XosNativeTheme,
} from "../../src/ui";

interface Last {
  readonly ok: boolean;
  readonly title: string;
  readonly code: string;
}

/** In or Out per zone, remembered for the session (B8): a gate that only lets people out stays on Out. */
const directionByZone = new Map<string, ScanDirection>();

/** A denial the person may override: the denied scan's client id and whose badge it was. */
interface Denied {
  readonly scanId: string;
  readonly name: string;
}

const DENY_KEY = {
  unknown: "compass.scan.deny.unknown",
  revoked: "compass.scan.deny.revoked",
  "not-yet-valid": "compass.scan.deny.notYetValid",
  expired: "compass.scan.deny.expired",
  "no-zone-access": "compass.scan.deny.noZoneAccess",
  "outside-window": "compass.scan.deny.outsideWindow",
} as const;

const HINT: Readonly<Record<ScanMode, string>> = {
  asset: "compass.scan.hintAsset",
  receiving: "compass.scan.hintReceiving",
  credential: "compass.scan.hintCredential",
  lookup: "compass.scan.hintLookup",
};

/** Typed entry beside the camera, for worn labels and gloved hands. */
function ManualEntry({
  onCode,
  theme,
}: {
  readonly onCode: (raw: string, s: Symbology) => void;
  readonly theme: XosNativeTheme;
}): ReactElement {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: theme.space["8"],
        padding: theme.space["16"],
        backgroundColor: theme.color.bgSurface,
      }}
    >
      <View style={{ flex: 1 }}>
        <TextField
          testID="scan-manual"
          label={t("compass.scan.enterCode")}
          value={code}
          onChangeText={setCode}
          autoComplete="off"
        />
      </View>
      <Button
        testID="scan-manual-submit"
        label={t("compass.scan.submitCode")}
        disabled={code.trim().length === 0}
        onPress={() => {
          onCode(
            code.trim(),
            /^\d{8}$|^\d{12,14}$/.test(code.trim())
              ? code.trim().length === 14
                ? "itf14"
                : code.trim().length === 8
                  ? "ean8"
                  : "ean13"
              : "code128",
          );
          setCode("");
          // The result and count sit below the camera; close the keyboard so they show.
          Keyboard.dismiss();
        }}
      />
    </View>
  );
}

function BadgeView({ grant }: { readonly grant: ScanModeGrant }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { resolved, projectId } = useCompass();
  const personId = resolved?.identity.personId;
  const { rows } = useRows<
    CredentialRow &
      Row & {
        project_id?: string;
        project_name?: string;
        category_name?: string;
        category_code?: string;
      }
  >(
    "credentials",
    (c) =>
      c.project_id === projectId &&
      (c.holder_person_id === personId || grant.scope === "own-and-party"),
  );
  useEffect(() => {
    let previous: number | null = null;
    void Brightness.getBrightnessAsync().then((level) => {
      previous = level;
      return Brightness.setBrightnessAsync(1);
    });
    return () => {
      if (previous !== null) void Brightness.setBrightnessAsync(previous);
    };
  }, []);
  const own = rows.filter((c) => c.holder_person_id === personId && c.revoked_at === null);
  const party = rows.filter((c) => c.holder_person_id !== personId && c.revoked_at === null);
  if (own.length === 0 && party.length === 0) {
    return (
      <EmptyState
        testID="badge-empty"
        icon="key-round"
        sentence={t("compass.scan.badgeEmpty")}
        actionLabel={t("compass.common.refresh")}
      />
    );
  }
  const badge = (c: (typeof rows)[number]) => (
    <CredentialBadge
      key={c.id}
      testID={`badge-${c.credential_number}`}
      org={c.project_name ?? ""}
      name={c.holder_name ?? resolved?.identity.displayName ?? ""}
      role={c.category_name ?? ""}
      category={c.category_code ?? ""}
      categoryColor={1}
      credentialKey={c.credential_number}
      payload={`XOSCR1:${c.credential_number}`}
      zones={[]}
      validFrom={formatDay(c.valid_from)}
      validTo={c.valid_to ? formatDay(c.valid_to) : ""}
    />
  );
  return (
    <>
      <Text variant="heading20" heading>
        {t("compass.scan.badgeTitle")}
      </Text>
      <Text variant="text13" tone="tertiary">
        {t("compass.scan.brightness")}
      </Text>
      {own.map((c) => (
        <View key={c.id} style={{ gap: theme.space["8"] }}>
          {badge(c)}
          {/* The badge in Wallet, offline and one tap from the lock screen (A65-011 part 4). */}
          <WalletButton kind="credential" id={c.id} testID={`wallet-${c.credential_number}`} />
        </View>
      ))}
      {party.length > 0 ? (
        <>
          <Text variant="heading20" heading>
            {t("compass.scan.partyBadges")}
          </Text>
          {party.map(badge)}
        </>
      ) : null}
    </>
  );
}

function LiveScan({
  grant,
  modes,
  onModeChange,
}: {
  readonly grant: ScanModeGrant;
  readonly modes?: { value: "asset" | "receiving" | "credential"; label: string }[];
  readonly onModeChange?: (mode: "asset" | "receiving" | "credential") => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { resolved, projectId, enqueue, settings, orgSettings, client } = useCompass();
  const identity = resolved?.identity;
  const [last, setLastState] = useState<Last | undefined>(undefined);
  // Each result is announced as well as shown: iOS has no live regions (A23-004).
  const setLast = (next: Last) => {
    setLastState(next);
    announce(scanAnnouncement(next));
  };
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [direction, setDirectionState] = useState<ScanDirection>("In");
  const setDirection = (next: ScanDirection) => {
    if (zoneId) directionByZone.set(zoneId, next);
    setDirectionState(next);
  };
  useEffect(() => {
    setDirectionState(zoneId ? (directionByZone.get(zoneId) ?? "In") : "In");
  }, [zoneId]);
  // Override (B8, 2970): offered after a denial other than revoked, to a person who holds credentials.credential.issue
  // on the project by the answer read online once per project.
  const capabilities = useProjectCapabilities(projectId);
  const [denied, setDenied] = useState<Denied | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // Inside now for the chosen zone (app.zone_counts_live), read online after each scan; hidden offline.
  const [inside, setInside] = useState<number | null>(null);
  const [insideTick, setInsideTick] = useState(0);
  useEffect(() => {
    if (grant.mode !== "credential" || !projectId || !zoneId) {
      setInside(null);
      return;
    }
    let live = true;
    void zoneCountsLive(client as unknown as XosClient, projectId).then((counts) => {
      if (live) setInside(counts.ok ? (zoneTotals(counts.data).get(zoneId) ?? 0) : null);
    });
    return () => {
      live = false;
    };
  }, [client, grant.mode, projectId, zoneId, insideTick]);
  const batch = useRef(new ContinuousScan());
  const [count, setCount] = useState(0);
  // NFC beside the camera (A92): a tag held to the phone is one more code. Lookup can also write a found
  // unit's asset tag to a blank sticker, so the sticker scans as that unit from then on.
  const nfcState = useNfcAvailability();
  const [foundTag, setFoundTag] = useState<string | null>(null);
  const { rows: credentials } = useRows<CredentialRow & Row & { project_id?: string }>(
    "credentials",
    (c) => c.project_id === projectId,
  );
  const { rows: grid } = useRows<AccessGridRow & Row & { project_id?: string }>(
    "access_grid",
    (g) => g.project_id === projectId,
  );
  const { rows: zones } = useRows<Row & { code: string; name: string }>("zones");
  const { rows: units } = useRows<AssetUnitRow & Row>("asset_units");
  const { rows: identifiers } = useRows<AssetIdentifierRow & Row>("asset_identifiers");
  const { rows: custody } = useRows<CustodyRow & Row>("asset_custody");
  const zonesInGrid = zones.filter((z) => grid.some((g) => g.zone_id === z.id));
  // Receive against an order (R7a): while an order is open in the sheet, scans fill its serialized line's tags.
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveSheet, setReceiveSheet] = useState<ReceiveSheet | null>(null);
  const canReceiveOrder =
    grant.mode === "receiving" &&
    identity !== undefined &&
    access(identity, "scan.receiving.order", projectId).allowed;
  const haptic = (ok: boolean) => {
    if (hapticsOn(settings.haptics, orgSettings))
      void Haptics.notificationAsync(
        ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
      );
  };
  const intake = (raw: string, symbology: Symbology) => {
    if (!projectId || !resolved?.orgId) return;
    void enqueue(
      buildIntake(
        raw,
        symbology,
        { orgId: resolved.orgId, projectId, mode: grant.mode, deviceAt: new Date().toISOString() },
        Date.now(),
      ),
    );
    setLast({ ok: false, title: t("compass.scan.intake"), code: raw });
  };
  const onCode = (raw: string, symbology: Symbology | null) => {
    const code = classify(raw, symbology);
    if (code.kind === "invalid") {
      haptic(false);
      setLast({
        ok: false,
        title: t(
          code.reason === "checksum" ? "compass.scan.invalidChecksum" : "compass.scan.unsupported",
        ),
        code: raw,
      });
      return;
    }
    const sym = symbology ?? "code128";
    if (grant.mode === "receiving" && receiveSheet) {
      const next = addScannedTag(receiveSheet, raw);
      haptic(next !== receiveSheet);
      setReceiveSheet(next);
      setLast({
        ok: next !== receiveSheet,
        title: t(
          next !== receiveSheet
            ? "compass.scan.receiveOrder.tagAdded"
            : "compass.scan.receiveOrder.tagSkipped",
        ),
        code: raw,
      });
      return;
    }
    if (grant.mode === "receiving") {
      if (batch.current.add(raw, sym, Date.now())) {
        haptic(true);
        setCount(batch.current.total);
        setLast({ ok: true, title: t("compass.scan.receivingAck"), code: raw });
      }
      return;
    }
    if (grant.mode === "credential") {
      if (code.kind !== "credential" || !zoneId) {
        haptic(false);
        setLast({
          ok: false,
          title: t(zoneId ? "compass.scan.deny.unknown" : "compass.scan.chooseZone"),
          code: raw,
        });
        return;
      }
      if (direction === "Out") {
        // Exit is never refused (2970): the scan is recorded as Out without the device deciding anything.
        const credential = credentials.find((c) => c.credential_number === code.credentialNumber);
        setDenied(null);
        if (!credential) {
          haptic(false);
          setLast({
            ok: false,
            title: t("compass.scan.deny.unknown"),
            code: code.credentialNumber,
          });
          return;
        }
        haptic(true);
        setLast({
          ok: true,
          title: gateScanTitle(t("compass.scan.exitRecorded"), credential.holder_name),
          code: code.credentialNumber,
        });
        void enqueue(
          buildAccessScan(
            credential,
            zoneId,
            { result: "Granted", credential },
            new Date().toISOString(),
            Date.now(),
            undefined,
            "Out",
          ),
        ).then(() => setInsideTick((n) => n + 1));
        return;
      }
      const decision = decideGate(code.credentialNumber, zoneId, credentials, grid, Date.now());
      haptic(decision.result === "Granted");
      setLast({
        ok: decision.result === "Granted",
        title:
          decision.result === "Granted"
            ? gateScanTitle(t("compass.scan.granted"), decision.credential.holder_name)
            : gateScanTitle(t("compass.scan.denied"), t(DENY_KEY[decision.reason])),
        code: code.credentialNumber,
      });
      if (decision.credential) {
        const scan = buildAccessScan(
          decision.credential,
          zoneId,
          decision,
          new Date().toISOString(),
          Date.now(),
        );
        void enqueue(scan).then(() => setInsideTick((n) => n + 1));
        setDenied(
          canOverride(decision, capabilities)
            ? { scanId: scan.rowId, name: decision.credential.holder_name ?? code.credentialNumber }
            : null,
        );
      } else {
        setDenied(null);
      }
      return;
    }
    const found = resolveAsset(code, units, identifiers, custody);
    if (found.kind !== "unit") {
      haptic(false);
      setFoundTag(null);
      intake(raw, sym);
      return;
    }
    if (grant.mode === "lookup") {
      haptic(true);
      setFoundTag(found.unit.asset_tag);
      setLast({
        ok: true,
        title: t("compass.scan.assetFound", { tag: found.unit.asset_tag }),
        code: raw,
      });
      return;
    }
    if (custodyBlocked(found.unit)) {
      haptic(false);
      setLast({
        ok: false,
        title: `${found.unit.asset_tag} · ${found.unit.asset_state}`,
        code: raw,
      });
      return;
    }
    if (resolved?.orgId && identity) {
      const me = {
        membershipId: identity.membershipId,
        engagementIds: identity.engagements.map((e) => e.id),
      };
      void enqueue(
        buildAssetScan(
          {
            orgId: resolved.orgId,
            code: found.unit.asset_tag,
            unitId: found.unit.id,
            action: assetScanAction(found.unit, found.custody, me),
            custodianMembershipId: identity.membershipId,
            custodianEngagementId:
              identity.membershipId === null
                ? (found.custody?.custodian_engagement_id ?? null)
                : null,
            venueId: null,
            projectId,
            note: null,
          },
          Date.now(),
        ),
      );
    }
    haptic(true);
    setLast({
      ok: true,
      title: t("compass.scan.assetFound", { tag: found.unit.asset_tag }),
      code: raw,
    });
  };
  const readTag = async () => {
    if (nfcState === "off") {
      haptic(false);
      setLast({ ok: false, title: t("compassNfc.off"), code: "" });
      return;
    }
    try {
      const tag = await nfc.read(t(`compassNfc.alert.${grant.mode}`));
      if (!tag) return;
      const found = codeFromTag(tag);
      if (!found) {
        haptic(false);
        setLast({ ok: false, title: t("compassNfc.unreadable"), code: "" });
        return;
      }
      onCode(found.code, "nfc");
    } catch (error) {
      haptic(false);
      setLast({
        ok: false,
        title: t("compassNfc.failed"),
        code: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const writeTag = async (tag: string) => {
    try {
      const written = await nfc.write(encodeTextMessage(tag), t("compassNfc.alert.write", { tag }));
      if (!written) return;
      haptic(true);
      setLast({ ok: true, title: t("compassNfc.written", { tag }), code: tag });
    } catch (error) {
      haptic(false);
      setLast({
        ok: false,
        title: t("compassNfc.writeFailed"),
        code: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const nfcButton =
    nfcState === "ready" || nfcState === "off"
      ? { label: t("compassNfc.read"), onPress: () => void readTag() }
      : undefined;
  // Journey 53: a receiving batch is reviewed before it saves; each line can lose a miscounted unit.
  const [reviewing, setReviewing] = useState(false);
  const done = () => {
    if (grant.mode === "receiving" && batch.current.total > 0) {
      setReviewing(true);
      return;
    }
    router.navigate("/today");
  };
  const saveBatch = () => {
    for (const item of batch.current.items())
      for (let i = 0; i < item.count; i += 1) intake(item.code, item.symbology);
    batch.current = new ContinuousScan();
    setCount(0);
    setReviewing(false);
    router.navigate("/today");
  };
  return (
    <View style={{ flex: 1 }}>
      {/* First under the mode chips, above the access points and the camera, so the keyboard never
          covers what is typed: it hid the field below the sheet, and then (A66) below the access points
          once a project's grid named five of them. */}
      <ManualEntry onCode={onCode} theme={theme} />
      {grant.mode === "lookup" && foundTag && nfcState === "ready" ? (
        <View style={{ paddingHorizontal: theme.space["16"] }}>
          <Button
            testID="scan-nfc-write"
            variant="secondary"
            icon="nfc"
            block
            label={t("compassNfc.write", { tag: foundTag })}
            onPress={() => void writeTag(foundTag)}
          />
        </View>
      ) : null}
      {grant.mode === "credential" ? (
        <View style={{ padding: theme.space["16"], gap: theme.space["8"] }}>
          <Text variant="label13" tone="secondary">
            {t("compass.scan.zone")}
          </Text>
          <SegmentedControl
            testID="scan-zone"
            label={t("compass.scan.zone")}
            value={zoneId ?? ""}
            options={zonesInGrid.map((z) => ({ value: z.id, label: z.name }))}
            onChange={setZoneId}
          />
          <SegmentedControl
            testID="scan-direction"
            label={t("compass.scan.directionLabel")}
            value={direction}
            options={[
              { value: "In", label: t("compass.scan.in") },
              { value: "Out", label: t("compass.scan.out") },
            ]}
            onChange={(value) => setDirection(value === "Out" ? "Out" : "In")}
          />
          {inside !== null ? (
            <Text variant="label13" tone="secondary" testID="scan-inside-now">
              {t("compass.scan.insideNow", { count: inside })}
            </Text>
          ) : null}
          {denied ? (
            <Button
              testID="scan-override"
              variant="secondary"
              icon="key-round"
              block
              label={t("compass.scan.override")}
              onPress={() => {
                setOverrideReason("");
                setOverrideOpen(true);
              }}
            />
          ) : null}
        </View>
      ) : null}
      <Sheet
        open={overrideOpen && denied !== null}
        title={t("compass.scan.overrideTitle")}
        closeLabel={t("compass.common.close")}
        onClose={() => setOverrideOpen(false)}
        footer={
          <Button
            testID="scan-override-submit"
            variant="primary"
            block
            label={t("compass.scan.overrideSubmit")}
            disabled={overrideReason.trim().length === 0 || overrideReason.trim().length > 300}
            onPress={() => {
              if (!denied) return;
              void enqueue(buildScanOverride(denied.scanId, overrideReason, Date.now()));
              haptic(true);
              setLast({
                ok: true,
                title: gateScanTitle(t("compass.scan.overrideQueued"), denied.name),
                code: "",
              });
              setDenied(null);
              setOverrideOpen(false);
            }}
          />
        }
      >
        <TextField
          testID="scan-override-reason"
          label={t("compass.scan.overrideReason")}
          help={t("compass.scan.overrideReasonHelp")}
          value={overrideReason}
          multiline
          onChangeText={setOverrideReason}
        />
      </Sheet>
      {canReceiveOrder ? (
        <View style={{ paddingHorizontal: theme.space["16"] }}>
          <Button
            testID="scan-receive-order"
            variant="secondary"
            icon="clipboard-list"
            block
            label={t(
              receiveSheet ? "compass.scan.receiveOrder.resume" : "compass.scan.receiveOrder.open",
            )}
            onPress={() => setReceiveOpen(true)}
          />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <ScanSheet
          testID="scan-sheet"
          mode={grant.mode === "lookup" ? "asset" : grant.mode}
          hint={t(HINT[grant.mode])}
          count={count}
          countLabel={t("compass.scan.scanned")}
          doneLabel={t("compass.common.done")}
          onDone={done}
          {...(last ? { last } : {})}
          camera={<Scanner onCode={onCode} />}
          {...(nfcButton ? { nfc: nfcButton } : {})}
          {...(modes && onModeChange ? { modes, onModeChange } : {})}
        />
      </View>
      <FakeNfcSheet />
      {canReceiveOrder ? (
        <ReceiveOrderSheet
          open={receiveOpen}
          sheet={receiveSheet}
          onSheet={setReceiveSheet}
          onClose={() => setReceiveOpen(false)}
          onQueued={(n) => {
            setReceiveOpen(false);
            setLast({
              ok: true,
              title: t("compass.scan.receiveOrder.queued", { count: n }),
              code: "",
            });
          }}
        />
      ) : null}
      <Sheet
        open={reviewing}
        title={t("compass.scan.review.title", { count })}
        closeLabel={t("compass.scan.review.keep")}
        onClose={() => setReviewing(false)}
      >
        <View testID="batch-review" style={{ gap: theme.space["8"] }}>
          {batch.current.items().map((item) => (
            <ListRow
              key={item.code}
              testID={`batch-item-${item.code}`}
              icon="package"
              title={item.code}
              subtitle={t("compass.scan.review.count", { count: item.count })}
              trailing={
                <IconButton
                  testID={`batch-remove-${item.code}`}
                  icon="minus"
                  label={t("compass.scan.review.removeOne", { code: item.code })}
                  onPress={() => {
                    batch.current.decrement(item.code);
                    setCount(batch.current.total);
                    if (batch.current.total === 0) setReviewing(false);
                  }}
                />
              }
            />
          ))}
          <Button
            testID="batch-save"
            size="lg"
            block
            label={t("compass.scan.review.save", { count })}
            onPress={saveBatch}
          />
          <Button
            testID="batch-keep"
            variant="secondary"
            block
            label={t("compass.scan.review.keep")}
            onPress={() => setReviewing(false)}
          />
        </View>
      </Sheet>
    </View>
  );
}

function VendorDeliveries(): ReactElement {
  const { t } = useTranslation();
  const { projectId } = useCompass();
  const { rows } = useRows<
    Row & {
      project_id: string;
      zone_name?: string;
      starts_at: string;
      tracking_identifier?: string | null;
    }
  >("dock_slots", (d) => d.project_id === projectId);
  if (rows.length === 0)
    return (
      <EmptyState
        icon="package"
        sentence={t("compass.scan.vendorEmpty")}
        actionLabel={t("compass.common.refresh")}
      />
    );
  return (
    <Card title={t("nav.compass.content.dockSlot")}>
      {rows.map((d) => (
        <ListRow
          key={d.id}
          icon="package"
          title={d.zone_name ?? ""}
          subtitle={`${formatDay(d.starts_at)} · ${d.tracking_identifier ?? ""}`}
        />
      ))}
    </Card>
  );
}

export default function ScanScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { resolved, projectId } = useCompass();
  const identity = resolved?.identity;
  const grants = identity ? scanModes(identity.audience) : [];
  const [mode, setMode] = useState<ScanMode | null>(null);
  const active = grants.find((g) => g.mode === mode) ?? grants[0];
  if (!identity)
    return (
      <Screen>
        <Text>{t("compass.common.loading")}</Text>
      </Screen>
    );
  if (!active) {
    return (
      <Screen testID="scan" title={t("compass.scan.title")}>
        <EmptyState
          testID="scan-no-modes"
          icon="scan-line"
          sentence={t("compass.scan.noModes")}
          actionLabel={t("compass.scan.goToday")}
          onAction={() => router.navigate("/today")}
        />
      </Screen>
    );
  }
  const engagementOpen =
    identity.membershipId !== null || operationalEngagements(identity, projectId).length > 0;
  const feature =
    active.mode === "credential"
      ? active.scope === "all"
        ? "scan.credential.validate"
        : "scan.credential.badge"
      : active.mode === "receiving"
        ? "scan.receiving"
        : active.mode === "asset"
          ? "scan.asset"
          : "scan.lookup";
  const decision = access(identity, feature, projectId);
  const header = (
    <>
      <ProjectPicker />
      <SyncBanner />
      {grants.length > 1 ? (
        <SegmentedControl
          testID="scan-mode"
          label={t("compass.scan.modes")}
          value={active.mode}
          options={grants.map((g) => ({ value: g.mode, label: t(`nav.compass.scan.${g.mode}`) }))}
          onChange={(v) => setMode(v as ScanMode)}
        />
      ) : null}
    </>
  );
  const badgeMode = active.mode === "credential" && active.scope !== "all";
  const vendorMode = active.mode === "receiving" && active.scope === "acknowledgment";
  const assignedMode = active.mode === "asset" && active.scope === "assigned";
  if (!decision.allowed || !engagementOpen || badgeMode || vendorMode || assignedMode) {
    return (
      <Screen testID="scan" title={t("compass.scan.title")}>
        {header}
        {!decision.allowed ? (
          <DenialNotice reason={decision.reason} />
        ) : badgeMode ? (
          <BadgeView grant={active} />
        ) : vendorMode ? (
          <VendorDeliveries />
        ) : (
          <EmptyState
            testID="assigned-gear-empty"
            icon="package"
            sentence={t("compass.scan.assignedEmpty")}
            actionLabel={t("compass.common.refresh")}
          />
        )}
      </Screen>
    );
  }
  // The sheet switches between asset, receiving and credential itself; lookup needs the header picker.
  const sheetModes = grants.every((g) => g.mode !== "lookup")
    ? grants.map((g) => ({
        value: g.mode as "asset" | "receiving" | "credential",
        label: t(`nav.compass.scan.${g.mode}`),
      }))
    : null;
  return (
    <Screen testID="scan" title={t("compass.scan.title")} scroll={false}>
      {sheetModes ? (
        <>
          <ProjectPicker />
          <SyncBanner />
        </>
      ) : (
        header
      )}
      <View style={{ flex: 1 }}>
        <LiveScan
          key={`${active.mode}-${projectId ?? ""}`}
          grant={active}
          {...(sheetModes ? { modes: sheetModes, onModeChange: (m) => setMode(m) } : {})}
        />
      </View>
    </Screen>
  );
}
