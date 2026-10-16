import type { Row } from "@xos/sync";
import * as Brightness from "expo-brightness";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  access,
  operationalEngagements,
  scanModes,
  type ScanMode,
  type ScanModeGrant,
} from "../../src/domain/access";
import {
  buildAccessScan,
  assetScanAction,
  buildAssetScan,
  buildIntake,
  classify,
  ContinuousScan,
  custodyBlocked,
  decideGate,
  resolveAsset,
  type AccessGridRow,
  type AssetIdentifierRow,
  type AssetUnitRow,
  type CredentialRow,
  type CustodyRow,
  type Symbology,
} from "../../src/domain/scan";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { DenialNotice, formatDay, ProjectPicker, SyncBanner } from "../../src/screens/common";
import { Scanner } from "../../src/screens/Scanner";
import {
  Button,
  Card,
  CredentialBadge,
  EmptyState,
  ListRow,
  ScanSheet,
  Screen,
  SegmentedControl,
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
        }}
      />
    </View>
  );
}

function BadgeView({ grant }: { readonly grant: ScanModeGrant }): ReactElement {
  const { t } = useTranslation();
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
      {own.map(badge)}
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

function LiveScan({ grant }: { readonly grant: ScanModeGrant }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { resolved, projectId, enqueue, settings } = useCompass();
  const identity = resolved?.identity;
  const [last, setLast] = useState<Last | undefined>(undefined);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const batch = useRef(new ContinuousScan());
  const [count, setCount] = useState(0);
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
  const haptic = (ok: boolean) => {
    if (settings.haptics)
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
      const decision = decideGate(code.credentialNumber, zoneId, credentials, grid, Date.now());
      haptic(decision.result === "Granted");
      setLast({
        ok: decision.result === "Granted",
        title:
          decision.result === "Granted"
            ? `${t("compass.scan.granted")} · ${decision.credential.holder_name ?? ""}`
            : `${t("compass.scan.denied")} · ${t(DENY_KEY[decision.reason])}`,
        code: code.credentialNumber,
      });
      if (decision.credential)
        void enqueue(
          buildAccessScan(
            decision.credential,
            zoneId,
            decision,
            new Date().toISOString(),
            Date.now(),
          ),
        );
      return;
    }
    const found = resolveAsset(code, units, identifiers, custody);
    if (found.kind !== "unit") {
      haptic(false);
      intake(raw, sym);
      return;
    }
    if (grant.mode === "lookup") {
      haptic(true);
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
  const done = () => {
    if (grant.mode === "receiving") {
      for (const item of batch.current.items())
        for (let i = 0; i < item.count; i += 1) intake(item.code, item.symbology);
      batch.current = new ContinuousScan();
      setCount(0);
    }
    router.navigate("/today");
  };
  return (
    <View style={{ flex: 1 }}>
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
        />
      </View>
      <ManualEntry onCode={onCode} theme={theme} />
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
  return (
    <Screen testID="scan" title={t("compass.scan.title")} scroll={false}>
      {header}
      <View style={{ flex: 1 }}>
        <LiveScan key={`${active.mode}-${projectId ?? ""}`} grant={active} />
      </View>
    </Screen>
  );
}
