import { listMyBlocks, unblock, type Block } from "@xos/data/access-controls";
import type { XosClient } from "@xos/data/client";
import { revokeProfileShare } from "@xos/data/gateway";
import { PROFILE_SECTIONS } from "@xos/data/profiles";
import type { Row } from "@xos/sync";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import { useMirror, useQueuedWrite } from "../../src/screens/settings/hooks";
import {
  ConfirmSheet,
  LabeledChoice,
  OfflineNotice,
  WriteNotice,
} from "../../src/screens/settings/parts";
import { profileRuleKey } from "../../src/screens/settings/ProfileLists";
import {
  changedColumns,
  privacyColumns,
  VISIBILITIES,
  type Visibility,
} from "../../src/settings/forms";
import { readMyProfile, readMyRows } from "../../src/settings/reads";
import { isLive, MIRROR, profileUpdate, sectionVisibilityWrite } from "../../src/settings/writes";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  Skeleton,
  Switch,
  Tag,
  Text,
} from "../../src/ui";

const isVisibility = (value: unknown): value is Visibility =>
  typeof value === "string" && (VISIBILITIES as readonly string[]).includes(value);

/** Who sees the profile, whether the marketplace lists it and whether search engines may index it. */
function WhoSees({ row }: { readonly row: Row }): ReactElement {
  const { t } = useTranslation();
  const write = useQueuedWrite();
  const [visibility, setVisibility] = useState<Visibility>(
    isVisibility(row["visibility"]) ? row["visibility"] : "Private",
  );
  const [discoverable, setDiscoverable] = useState(row["marketplace_discoverable"] === true);
  const [indexing, setIndexing] = useState(row["search_indexing"] === true);
  const save = () => {
    const changes = changedColumns(
      row,
      privacyColumns({
        visibility,
        marketplaceDiscoverable: discoverable,
        searchIndexing: indexing,
      }),
    );
    if (Object.keys(changes).length === 0) write.unchanged();
    else void write.save(profileUpdate(row, changes));
  };
  return (
    <Card testID="settings-privacy-visibility" title={t("profiles.privacy.visibility")}>
      <LabeledChoice
        testID="settings-privacy-visibility-choice"
        label={t("profiles.privacy.visibility")}
        value={visibility}
        options={VISIBILITIES.map((v) => ({ value: v, label: t(`profiles.visibility.${v}`) }))}
        onChange={(v) => {
          if (!isVisibility(v)) return;
          setVisibility(v);
          // Only a Public profile can be indexed (person_profiles_indexing_public).
          if (v !== "Public") setIndexing(false);
        }}
      />
      <Text variant="text13" tone="tertiary">
        {t(`profiles.privacy.visibilityHelp.${visibility}`)}
      </Text>
      <Switch
        testID="settings-privacy-discoverable"
        label={t("profiles.privacy.discoverable")}
        value={discoverable}
        onChange={setDiscoverable}
      />
      <Switch
        testID="settings-privacy-indexing"
        label={t("profiles.privacy.indexing")}
        help={t("profiles.privacy.indexingHelp")}
        value={indexing && visibility === "Public"}
        disabled={visibility !== "Public"}
        onChange={setIndexing}
      />
      <Button
        testID="settings-privacy-save"
        block
        loading={write.state.kind === "sending"}
        label={t("profiles.privacy.save")}
        onPress={save}
      />
      <WriteNotice state={write.state} ruleKey={profileRuleKey} testID="settings-privacy" />
    </Card>
  );
}

/**
 * Each section's visibility (app.profile_section_visibility): narrower than the profile, never wider. A choice
 * saves at once and queues offline.
 */
function EachSection({ personId }: { readonly personId: string }): ReactElement {
  const { t } = useTranslation();
  const { client } = useCompass();
  const write = useQueuedWrite();
  const read = useCallback(
    () => readMyRows(client, "profile_section_visibility", personId),
    [client, personId],
  );
  const mirror = useMirror<Row>(MIRROR.sections, read);
  const current = (section: string) =>
    mirror.rows.find((r) => r["section"] === section && isLive(r));
  return (
    <Card testID="settings-privacy-sections" title={t("profiles.privacy.sections")}>
      <Text variant="text13" tone="tertiary">
        {t("profiles.privacy.sectionsHelp")}
      </Text>
      {!mirror.ready ? (
        mirror.notLoaded ? (
          <OfflineNotice kind="first" testID="settings-privacy-sections-first" />
        ) : (
          <Skeleton lines={4} />
        )
      ) : (
        PROFILE_SECTIONS.map((section) => {
          const value = current(section)?.["visibility"];
          return (
            <LabeledChoice
              key={section}
              testID={`settings-privacy-section-${section}`}
              label={t(`profiles.sections.${section}`)}
              value={isVisibility(value) ? value : "inherit"}
              options={[
                { value: "inherit", label: t("profiles.privacy.inherit") },
                ...VISIBILITIES.map((v) => ({ value: v, label: t(`profiles.visibility.${v}`) })),
              ]}
              onChange={(next) => {
                if (next !== "inherit" && !isVisibility(next)) return;
                const input = sectionVisibilityWrite(
                  personId,
                  section,
                  next,
                  current(section),
                  Date.now(),
                );
                if (input) void write.save(input);
              }}
            />
          );
        })
      )}
      <WriteNotice state={write.state} testID="settings-privacy-sections" />
    </Card>
  );
}

interface Share {
  readonly id: string;
  readonly orgName: string;
  readonly sharedAt: string | null;
  readonly revokedAt: string | null;
}

/** The shares of the profile given to orgs when applying (api_external.my_profile_shares), with Revoke. Online. */
function Shares(): ReactElement {
  const { t, i18n } = useTranslation();
  const { client, network } = useCompass();
  const [shares, setShares] = useState<readonly Share[] | null | "failed">(null);
  const [revoking, setRevoking] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(iso));
  const read = useCallback(async () => {
    const { data, error: failed } = await client
      .schema("api_external")
      .from("my_profile_shares")
      .select("id, org_name, shared_at, revoked_at")
      .order("shared_at", { ascending: false });
    setShares(
      failed || !Array.isArray(data)
        ? "failed"
        : (data as Record<string, string | null>[]).flatMap((r) =>
            r["id"]
              ? [
                  {
                    id: r["id"],
                    orgName: r["org_name"] ?? "",
                    sharedAt: r["shared_at"] ?? null,
                    revokedAt: r["revoked_at"] ?? null,
                  },
                ]
              : [],
          ),
    );
  }, [client]);
  useEffect(() => {
    if (network.isConnected) void read();
  }, [network.isConnected, read]);
  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    const result = await revokeProfileShare(client as unknown as XosClient, revoking.id);
    setBusy(false);
    if (!result.ok) {
      setError(t("compassSettings.common.failed"));
      return;
    }
    setRevoking(null);
    await read();
  };
  return (
    <Card testID="settings-privacy-shares" title={t("gateway.profile.shares.title")}>
      <Text variant="text13" tone="tertiary">
        {t("gateway.settings.privacy.sharesBody")}
      </Text>
      {!network.isConnected ? (
        <OfflineNotice kind="needs" testID="settings-privacy-shares-offline" />
      ) : shares === null ? (
        <Skeleton lines={2} />
      ) : shares === "failed" ? (
        <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
      ) : shares.length === 0 ? (
        <Text tone="secondary">{t("gateway.profile.shares.empty")}</Text>
      ) : (
        shares.map((s) => {
          const meta = [
            s.sharedAt ? t("gateway.profile.shares.shared", { date: date(s.sharedAt) }) : null,
            s.revokedAt ? t("gateway.profile.shares.revoked", { date: date(s.revokedAt) }) : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <ListRow
              key={s.id}
              testID="settings-privacy-share"
              title={s.orgName}
              {...(meta ? { subtitle: meta } : {})}
              trailing={
                s.revokedAt ? undefined : (
                  <Button
                    testID="settings-privacy-share-revoke"
                    variant="ghost"
                    label={t("gateway.profile.shares.revoke")}
                    onPress={() => {
                      setError(null);
                      setRevoking(s);
                    }}
                  />
                )
              }
            />
          );
        })
      )}
      <ConfirmSheet
        testID="settings-privacy-revoke"
        open={revoking !== null}
        title={t("compassSettings.privacy.revokeTitle", { org: revoking?.orgName ?? "" })}
        sentence={t("gateway.settings.privacy.sharesBody")}
        confirmLabel={t("gateway.profile.shares.revoke")}
        danger
        busy={busy}
        error={error}
        onConfirm={() => void revoke()}
        onClose={() => setRevoking(null)}
      />
    </Card>
  );
}

/**
 * The people, and organizations blocked from Gateway, that the person blocked, each with Unblock (ADR 0033 decision
 * 57). A block hides their posts, comments, shout-outs and messages from this person; unblocking shows them again.
 * Online only.
 */
function Blocked(): ReactElement {
  const { t } = useTranslation();
  const { client, network } = useCompass();
  const db = client as unknown as XosClient;
  const [blocks, setBlocks] = useState<readonly Block[] | null | "failed">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const read = useCallback(async () => {
    const result = await listMyBlocks(db);
    setBlocks(result.ok ? result.data : "failed");
  }, [db]);
  useEffect(() => {
    if (network.isConnected) void read();
  }, [network.isConnected, read]);
  const lift = async (block: Block) => {
    const name = block.name ?? t("compassSettings.privacy.someone");
    setBusy(block.id);
    setMessage(null);
    const result = await unblock(db, block.id);
    setBusy(null);
    setMessage(
      result.ok
        ? { tone: "success", text: t("compassSettings.privacy.unblocked", { name }) }
        : { tone: "danger", text: t("compassSettings.privacy.unblockFailed", { name }) },
    );
    if (result.ok) await read();
  };
  return (
    <Card testID="settings-privacy-blocked" title={t("compassSettings.privacy.blockedTitle")}>
      <Text variant="text13" tone="tertiary">
        {t("compassSettings.privacy.blockedIntro")}
      </Text>
      {message ? (
        <InlineAlert testID="blocked-message" tone={message.tone} message={message.text} />
      ) : null}
      {!network.isConnected ? (
        <OfflineNotice kind="needs" testID="settings-privacy-blocked-offline" />
      ) : blocks === null ? (
        <Skeleton lines={2} />
      ) : blocks === "failed" ? (
        <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
      ) : blocks.length === 0 ? (
        <Text testID="blocked-empty" tone="secondary">
          {t("compassSettings.privacy.blockedEmpty")}
        </Text>
      ) : (
        blocks.map((block) => {
          const name = block.name ?? t("compassSettings.privacy.someone");
          return (
            <ListRow
              key={block.id}
              title={name}
              trailing={
                <>
                  {block.kind === "organization" ? (
                    <Tag label={t("compassSettings.privacy.organization")} />
                  ) : null}
                  <Button
                    testID="blocked-unblock"
                    variant="ghost"
                    label={t("compassSettings.privacy.unblock")}
                    loading={busy === block.id}
                    disabled={busy !== null}
                    onPress={() => void lift(block)}
                  />
                </>
              }
            />
          );
        })
      )}
    </Card>
  );
}

/**
 * Settings, Profile Privacy (sitemap settings.profile-privacy; Section 4.5.6 item 2): who sees the profile and each
 * section, marketplace discoverability and search indexing, which save on the phone offline (ADR 0070); and the
 * profile shares and blocks, which need a connection.
 */
export default function ProfilePrivacyScreen(): ReactElement {
  const { t } = useTranslation();
  const { client, network, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const read = useCallback(() => readMyProfile(client), [client]);
  const profile = useMirror<Row>(MIRROR.profile, personId ? read : null);
  const row = profile.rows[0];
  return (
    <Screen testID="settings-privacy" title={t("nav.settings.personal.profilePrivacy")}>
      <Text tone="secondary">{t("gateway.settings.leads.profilePrivacy")}</Text>
      {!network.isConnected && row ? <OfflineNotice kind="queues" /> : null}
      {row ? (
        <WhoSees key={row.id} row={row} />
      ) : profile.notLoaded ? (
        <OfflineNotice kind="first" />
      ) : profile.failed ? (
        <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
      ) : (
        <Skeleton testID="settings-privacy-loading" lines={4} />
      )}
      {personId ? <EachSection personId={personId} /> : null}
      <Shares />
      <Blocked />
    </Screen>
  );
}
