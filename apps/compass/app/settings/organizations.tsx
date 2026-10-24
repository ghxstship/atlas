import type { XosClient } from "@xos/data/client";
import {
  endAccountMembership,
  listAccountMembers,
  listMyAccounts,
  type ExternalAccount,
} from "@xos/data/gateway";
import { leaveOrganization, listMyOrganizations } from "@xos/data/identity";
import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../src/runtime/CompassProvider";
import { BrandChip } from "../../src/screens/OrgSwitcher";
import { useMirror, useQueuedWrite } from "../../src/screens/settings/hooks";
import { ConfirmSheet, OfflineNotice, WriteNotice } from "../../src/screens/settings/parts";
import {
  accountRoleKey,
  organizationRows,
  roleLabelKey,
  type HeldRole,
  type OrgRow,
} from "../../src/settings/organizations";
import { readDefaultOrgRow } from "../../src/settings/reads";
import { gatewaySectionUrl } from "../../src/settings/sections";
import { DEFAULT_ORG_ROW, defaultOrgWrite, MIRROR } from "../../src/settings/writes";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  Skeleton,
  Tag,
  Text,
  useTheme,
} from "../../src/ui";

/** The roles the person holds in each org, read online (listMyOrganizations, as Atlas's Organizations shows them). */
function useRoles(): ReadonlyMap<string, readonly HeldRole[]> {
  const { client, network, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const [roles, setRoles] = useState<ReadonlyMap<string, readonly HeldRole[]>>(new Map());
  useEffect(() => {
    if (!network.isConnected || !personId) return undefined;
    let live = true;
    void listMyOrganizations(client as unknown as XosClient, personId).then((orgs) => {
      if (!live || !orgs.ok) return;
      setRoles(
        new Map(orgs.data.map((o) => [o.id, o.roles.map((r) => ({ code: r.code, name: r.name }))])),
      );
    });
    return () => {
      live = false;
    };
  }, [client, network.isConnected, personId]);
  return roles;
}

interface AccountRow {
  readonly account: ExternalAccount;
  readonly membershipId: string | null;
}

/** The company accounts the person belongs to (Gateway's Organizations), with their own membership to leave. */
function useAccounts(attempt: number): readonly AccountRow[] | null | "failed" {
  const { client, network, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const [accounts, setAccounts] = useState<readonly AccountRow[] | null | "failed">(null);
  useEffect(() => {
    if (!network.isConnected || !personId) return undefined;
    let live = true;
    const db = client as unknown as XosClient;
    void (async () => {
      const mine = await listMyAccounts(db);
      if (!mine.ok) {
        if (live) setAccounts("failed");
        return;
      }
      const members = await Promise.all(mine.data.map((a) => listAccountMembers(db, a.id)));
      if (!live) return;
      setAccounts(
        mine.data.map((account, i) => {
          const list = members[i];
          const own = list?.ok ? list.data.find((m) => m.personId === personId) : undefined;
          return { account, membershipId: own?.membershipId ?? null };
        }),
      );
    })();
    return () => {
      live = false;
    };
  }, [client, network.isConnected, personId, attempt]);
  return accounts;
}

/**
 * Settings, Organizations (sitemap settings.organizations; Section 4.5.6 item 5): every org the person belongs to or
 * works with, each in its brand (src/screens/OrgSwitcher.tsx), with Open, Make Default and, for a membership, Leave;
 * and the company accounts they belong to. The default org (app.set_active_org) queues offline (ADR 0070); leaving
 * needs a connection, since access ends at once.
 */
export default function OrganizationsScreen(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, config, network, resolved, setOrgId, brands, retryIdentity } = useCompass();
  const db = client as unknown as XosClient;
  const offline = !network.isConnected;
  const roles = useRoles();
  const write = useQueuedWrite();
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    void client.auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? null));
  }, [client]);
  const readDefault = useCallback(
    () => (userId ? readDefaultOrgRow(client, userId) : Promise.resolve(null)),
    [client, userId],
  );
  const defaults = useMirror<Row>(MIRROR.defaultOrg, userId ? readDefault : null);
  const defaultOrgId = defaults.rows.find((r) => r.id === DEFAULT_ORG_ROW)?.["org_id"];
  const rows = useMemo(
    () =>
      organizationRows({
        contexts: resolved?.contexts ?? [],
        openOrgId: resolved?.orgId ?? null,
        defaultOrgId: typeof defaultOrgId === "string" ? defaultOrgId : null,
        roles,
        brandName: (orgId) => brands.get(orgId)?.name,
      }),
    [resolved, defaultOrgId, roles, brands],
  );
  const [accountsAttempt, setAccountsAttempt] = useState(0);
  const accounts = useAccounts(accountsAttempt);
  const [leaving, setLeaving] = useState<OrgRow | null>(null);
  const [leavingAccount, setLeavingAccount] = useState<AccountRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const leave = async () => {
    if (!leaving) return;
    setBusy(true);
    setError(null);
    const left = await leaveOrganization(db, leaving.orgId);
    setBusy(false);
    if (!left.ok) {
      setError(
        t(
          left.error.kind === "refusal" && left.error.rule === "sole_owner"
            ? "shell.settings.organizations.errors.sole_owner"
            : "shell.settings.organizations.errors.unexpected",
          { org: leaving.name },
        ),
      );
      return;
    }
    setNotice(t("compassSettings.organizations.left", { org: leaving.name }));
    setLeaving(null);
    // The person's orgs resolve again; the org's rows leave the phone with its scope (Section 13).
    retryIdentity();
  };

  const leaveAccount = async () => {
    if (!leavingAccount?.membershipId) return;
    setBusy(true);
    setError(null);
    const left = await endAccountMembership(db, leavingAccount.membershipId);
    setBusy(false);
    if (!left.ok) {
      setError(
        left.error.kind === "refusal"
          ? left.error.message.replace(/^[a-z_]+:\s*/, "")
          : t("compassSettings.common.failed"),
      );
      return;
    }
    setNotice(t("compassSettings.organizations.left", { org: leavingAccount.account.name }));
    setLeavingAccount(null);
    setAccountsAttempt((n) => n + 1);
  };

  const roleText = (row: OrgRow) =>
    row.roles
      .map((r) => {
        const label = roleLabelKey(r);
        return "name" in label ? label.name : t(label.key);
      })
      .join(", ");

  const orgRow = (row: OrgRow) => {
    const meta = [
      row.kind === "member"
        ? roleText(row) || t("compassSettings.organizations.member")
        : t(
            row.engagements === 1
              ? "compassSettings.organizations.engagementsOne"
              : "compassSettings.organizations.engagementsOther",
            { count: row.engagements },
          ),
    ];
    return (
      <View key={row.orgId} testID={`settings-org-${row.orgId}`}>
        <ListRow
          testID="settings-org"
          title={row.name}
          subtitle={meta.join(" · ")}
          trailing={<BrandChip orgId={row.orgId} name={row.name} />}
        />
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: theme.space["8"],
          }}
        >
          {row.open ? (
            <Tag
              testID="settings-org-open-now"
              tone="accent"
              label={t("compassSettings.organizations.openNow")}
            />
          ) : (
            <Button
              testID="settings-org-open"
              variant="ghost"
              label={t("compassSettings.organizations.open")}
              onPress={() => setOrgId(row.orgId)}
            />
          )}
          {row.isDefault ? (
            <Tag
              testID="settings-org-default"
              tone="success"
              label={t("compassSettings.organizations.default")}
            />
          ) : row.kind === "member" ? (
            <Button
              testID="settings-org-make-default"
              variant="ghost"
              label={t("compassSettings.organizations.makeDefault")}
              onPress={() => {
                setNotice(null);
                setOrgId(row.orgId);
                void write.save(defaultOrgWrite(row.orgId, new Date().toISOString()));
              }}
            />
          ) : null}
          {row.canLeave ? (
            <Button
              testID="settings-org-leave"
              variant="ghost"
              label={t("shell.settings.organizations.leave")}
              disabled={offline}
              onPress={() => {
                setError(null);
                setLeaving(row);
              }}
            />
          ) : null}
        </View>
      </View>
    );
  };

  const members = rows.filter((r) => r.kind === "member");
  const engaged = rows.filter((r) => r.kind === "engaged");
  return (
    <Screen testID="settings-organizations" title={t("nav.settings.personal.organizations")}>
      <Text tone="secondary">{t("compassSettings.leads.organizations")}</Text>
      {offline ? <OfflineNotice kind="queues" /> : null}
      {notice ? (
        <InlineAlert testID="settings-organizations-notice" tone="success" message={notice} />
      ) : null}
      {members.length > 0 ? (
        <Card
          testID="settings-organizations-members"
          title={t("compassSettings.organizations.membersTitle")}
        >
          <Text variant="text13" tone="tertiary">
            {t("compassSettings.organizations.defaultHelp")}
          </Text>
          {members.map(orgRow)}
          <WriteNotice state={write.state} testID="settings-organizations-default" />
        </Card>
      ) : null}
      {engaged.length > 0 ? (
        <Card
          testID="settings-organizations-engaged"
          title={t("compassSettings.organizations.engagedTitle")}
        >
          <Text variant="text13" tone="tertiary">
            {t("compassSettings.organizations.engagedHelp")}
          </Text>
          {engaged.map(orgRow)}
        </Card>
      ) : null}
      <Card
        testID="settings-organizations-accounts"
        title={t("gateway.settings.organizations.accounts")}
      >
        {offline ? (
          <OfflineNotice kind="needs" testID="settings-organizations-accounts-offline" />
        ) : accounts === null ? (
          <Skeleton lines={2} />
        ) : accounts === "failed" ? (
          <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
        ) : accounts.length === 0 ? (
          <Text tone="secondary">{t("compassSettings.organizations.accountsNone")}</Text>
        ) : (
          accounts.map((a) => (
            <ListRow
              key={a.account.id}
              testID="settings-organizations-account"
              title={a.account.name}
              subtitle={a.account.roles.map((r) => t(accountRoleKey(r))).join(", ")}
              trailing={
                a.membershipId ? (
                  <Button
                    testID="settings-organizations-account-leave"
                    variant="ghost"
                    label={t("gateway.settings.organizations.leave")}
                    onPress={() => {
                      setError(null);
                      setLeavingAccount(a);
                    }}
                  />
                ) : undefined
              }
            />
          ))
        )}
        <ListRow
          testID="settings-organizations-create-account"
          icon="external-link"
          title={t("gateway.settings.organizations.create")}
          subtitle={t("compassSettings.organizations.createInGateway")}
          onPress={() =>
            void Linking.openURL(gatewaySectionUrl(config.gatewayUrl, "/settings/organizations"))
          }
        />
      </Card>
      <ConfirmSheet
        testID="settings-org-leave-confirm"
        open={leaving !== null}
        title={t("shell.settings.organizations.leaveTitle", { org: leaving?.name ?? "" })}
        sentence={t("shell.settings.organizations.leaveBody", { org: leaving?.name ?? "" })}
        confirmLabel={t("shell.settings.organizations.leave")}
        danger
        busy={busy}
        error={error}
        onClose={() => setLeaving(null)}
        onConfirm={() => void leave()}
      />
      <ConfirmSheet
        testID="settings-account-leave-confirm"
        open={leavingAccount !== null}
        title={t("shell.settings.organizations.leaveTitle", {
          org: leavingAccount?.account.name ?? "",
        })}
        sentence={t("compassSettings.organizations.leaveAccountBody", {
          org: leavingAccount?.account.name ?? "",
        })}
        confirmLabel={t("gateway.settings.organizations.leave")}
        danger
        busy={busy}
        error={error}
        onClose={() => setLeavingAccount(null)}
        onConfirm={() => void leaveAccount()}
      />
    </Screen>
  );
}
