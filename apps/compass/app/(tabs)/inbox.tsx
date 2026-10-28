import { inboxItemInLens } from "@xos/data/role-lens";
import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { dispatchQueue, type IncidentRow, type Severity } from "../../src/domain/incidents";
import {
  inboxRecordKey,
  inboxTarget,
  type InboxNotificationRow,
} from "../../src/domain/notifications";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { useInboxNotifications, useNotificationPermission } from "../../src/runtime/notifications";
import {
  formatDay,
  ProjectPicker,
  SyncBanner,
  useAllowed,
  useRoleTitle,
} from "../../src/screens/common";
import { Button, Card, EmptyState, ListRow, Screen, Text } from "../../src/ui";

/**
 * One inbox model (Section 11.10 item 5): Needs You first, then For Your Information. Compass fills it
 * from what it already holds on the device: shifts waiting for acceptance, open incidents for dispatchers,
 * conflicts in the offline queue. The person's notifications join from the server (A101): approvals,
 * mentions and assignments under Needs You, the rest under For Your Information. A notification opens the
 * record it is about, as its push does, or the Gateway page it names when Compass has no screen for it. Under a
 * role lens (A128) a member sees what is addressed to them and what the lens role's capabilities brought them.
 */
export default function InboxScreen(): ReactElement {
  const { t } = useTranslation();
  const roleTitle = useRoleTitle();
  const router = useRouter();
  const { config, resolved, projectId, status, lens } = useCompass();
  const canDispatch = useAllowed("incidents.dispatch");
  const identity = resolved?.identity;
  const permission = useNotificationPermission();
  const notifications = useInboxNotifications();
  // Read again whenever the Inbox comes into view, so a notification that just arrived is listed.
  const { reload } = notifications;
  useFocusEffect(useCallback(() => reload(), [reload]));
  const { rows: shifts } = useRows<
    Row & {
      project_id: string;
      shift_state?: string;
      starts_at: string;
      membership_id?: string | null;
      engagement_id?: string | null;
      job_title?: string | null;
      role_code?: string | null;
    }
  >("shifts", (s) => s.project_id === projectId && s.shift_state === "Published");
  const { rows: incidents } = useRows<IncidentRow & Row & { project_id: string }>(
    "incidents",
    (i) => i.project_id === projectId,
  );
  const { rows: severities } = useRows<Severity & Row>("incident_severities");
  const engagementIds = new Set(identity?.engagements.map((e) => e.id) ?? []);
  const mine = shifts.filter(
    (s) =>
      (identity?.membershipId && s.membership_id === identity.membershipId) ||
      (s.engagement_id && engagementIds.has(s.engagement_id)),
  );
  const openIncidents = canDispatch
    ? dispatchQueue(incidents, severities).filter((i) => i.incident_state === "Reported")
    : [];
  const needs = [
    ...mine.map((s) => ({
      id: `shift-${s.id}`,
      icon: "calendar",
      title: roleTitle(s) || t("compass.schedule.myShifts"),
      subtitle: `${t("compass.schedule.published")} · ${formatDay(s.starts_at)}`,
      go: "/schedule" as const,
    })),
    ...openIncidents.map((i) => ({
      id: `incident-${i.id}`,
      icon: "siren",
      title: i.title,
      subtitle: t("compass.incidents.states.Reported"),
      go: "/incidents" as const,
    })),
    ...(status && status.conflicts > 0
      ? [
          {
            id: "conflicts",
            icon: "triangle-alert",
            title: t("compass.queue.title"),
            subtitle: t("compass.queue.conflict"),
            go: "/offline-queue" as const,
          },
        ]
      : []),
  ];
  const notificationRow = (n: InboxNotificationRow): ReactElement => {
    const target = inboxTarget(n);
    const title = typeof n.args["title"] === "string" ? n.args["title"].trim() : "";
    const org = typeof n.args["orgName"] === "string" ? n.args["orgName"].trim() : "";
    const subtitle = [
      inboxRecordKey(n),
      formatDay(n.createdAt),
      n.read ? null : t("compass.inbox.new"),
    ].filter((part): part is string => part !== null && part !== "");
    return (
      <ListRow
        key={n.id}
        testID={`inbox-notification-${n.id}`}
        icon="bell"
        title={
          title !== ""
            ? title
            : org !== ""
              ? t("compass.inbox.updateFrom", { org })
              : t("compass.inbox.update")
        }
        subtitle={subtitle.join(" · ")}
        {...(target === null
          ? {}
          : {
              onPress:
                target.kind === "route"
                  ? () => router.push(target.route as never)
                  : () =>
                      void Linking.openURL(
                        `${config.gatewayUrl.replace(/\/+$/, "")}${target.path}`,
                      ),
            })}
      />
    );
  };
  // The lens narrows the active org's notifications; another org's stay as they are.
  const lensed = notifications.rows.filter(
    (n) =>
      n.orgId !== resolved?.orgId ||
      inboxItemInLens(
        { kind: n.kind, subjectTable: n.subjectTable, documentType: n.documentType ?? null },
        lens.inbox,
      ),
  );
  const needsNotifications = lensed.filter((n) => n.section === "Needs You");
  const fyiNotifications = lensed.filter((n) => n.section !== "Needs You");
  return (
    <Screen testID="inbox" title={t("compass.inbox.title")}>
      <ProjectPicker />
      <SyncBanner />
      {permission.state === "ask" || permission.state === "denied" ? (
        <Card testID="inbox-notifications" title={t("compass.notifications.promptTitle")}>
          <Text tone="secondary">
            {t(
              permission.state === "ask"
                ? "compass.notifications.prompt"
                : "compass.notifications.denied",
            )}
          </Text>
          {permission.state === "ask" ? (
            <Button
              testID="inbox-notifications-on"
              icon="inbox"
              label={t("compass.notifications.turnOn")}
              onPress={() => void permission.request()}
            />
          ) : null}
        </Card>
      ) : null}
      {needs.length === 0 && notifications.rows.length === 0 ? (
        <EmptyState
          testID="inbox-empty"
          icon="inbox"
          sentence={t("compass.inbox.empty")}
          actionLabel={t("compass.scan.goToday")}
          onAction={() => router.navigate("/today")}
        />
      ) : null}
      {needs.length > 0 || needsNotifications.length > 0 ? (
        <Card title={t("compass.inbox.needsYou")}>
          {needs.map((n) => (
            <ListRow
              key={n.id}
              testID={`inbox-${n.id}`}
              icon={n.icon}
              title={n.title}
              subtitle={n.subtitle}
              onPress={() => router.push(n.go)}
            />
          ))}
          {needsNotifications.map(notificationRow)}
        </Card>
      ) : null}
      {fyiNotifications.length > 0 ? (
        <Card testID="inbox-fyi" title={t("compass.inbox.fyi")}>
          {fyiNotifications.map(notificationRow)}
        </Card>
      ) : null}
    </Screen>
  );
}
