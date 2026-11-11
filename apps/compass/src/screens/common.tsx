/**
 * Pieces every Compass screen shares: the access gate with its refusal state, the project header picker,
 * the always-visible sync banner and the loading and error states.
 */
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { access, refusalFor, type Denial, type Feature } from "../domain/access";
import { queueAnnouncement } from "../domain/announce";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { countKey } from "../runtime/i18n";
import { OrgSwitcher } from "./OrgSwitcher";
import {
  announce,
  Banner,
  Button,
  ErrorState,
  ListRow,
  OfflineBanner,
  RefusalNotice,
  Screen,
  Sheet,
  Skeleton,
  useTheme,
} from "../ui";

const DENIAL_KEYS: Readonly<Record<Denial, { title: string; reason: string }>> = {
  role: { title: "compass.denial.roleTitle", reason: "compass.denial.role" },
  capability: { title: "compass.denial.capabilityTitle", reason: "compass.denial.capability" },
  "engagement-not-active": {
    title: "compass.denial.notActiveTitle",
    reason: "compass.denial.notActive",
  },
  "engagement-closed": { title: "compass.denial.closedTitle", reason: "compass.denial.closed" },
  "roster-member": {
    title: "compass.denial.rosterMemberTitle",
    reason: "compass.denial.rosterMember",
  },
};

export function DenialNotice({ reason }: { readonly reason: Denial }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const keys = DENIAL_KEYS[reason];
  return (
    <RefusalNotice
      testID={`denial-${reason}`}
      outcome="REFUSE"
      title={t(keys.title)}
      reason={t(keys.reason)}
      actionLabel={t("compass.scan.goToday")}
      onAction={() => router.replace("/today")}
    />
  );
}

/**
 * Renders children only when the signed-in person may use the feature on the current project.
 *
 * A Gate that is the whole route passes the route's `title`: the skeleton and the refusal then draw in a
 * Screen, which clears the native large-title header and names the page there. Without it a refused
 * route was a blank page under the back button, the refusal card hidden behind the header (C-07). A Gate
 * nested in a Screen (Expenses, Clock Team) leaves `title` out and draws in place.
 */
export function Gate({
  feature,
  title,
  children,
}: {
  readonly feature: Feature;
  readonly title?: string;
  readonly children: ReactNode;
}): ReactElement {
  const { resolved, projectId } = useCompass();
  const framed = (body: ReactElement): ReactElement =>
    title === undefined ? (
      body
    ) : (
      <Screen testID={`gate-${feature}`} title={title}>
        {body}
      </Screen>
    );
  if (!resolved) return framed(<Skeleton lines={3} />);
  const decision = access(resolved.identity, feature, projectId);
  return decision.allowed ? <>{children}</> : framed(<DenialNotice reason={decision.reason} />);
}

export function useAllowed(feature: Feature): boolean {
  const { resolved, projectId } = useCompass();
  return resolved ? access(resolved.identity, feature, projectId).allowed : false;
}

/**
 * Why a screen made of these features is refused, or null when one is allowed (see refusalFor). While the person's
 * identity still loads it is "loading": the screen shows a skeleton, as a route-level Gate does, never a refusal that
 * may not be theirs (an internal supervisor was briefly told the screen is not part of their role).
 */
export function useRefusal(features: readonly Feature[]): Denial | "loading" | null {
  const { resolved, projectId } = useCompass();
  return resolved ? refusalFor(resolved.identity, features, projectId) : "loading";
}

/** The project and scope picker in every tab's header (Section 4.5.7). */
export function ProjectPicker(): ReactElement | null {
  const { t } = useTranslation();
  const theme = useTheme();
  const { resolved, projectId, setProjectId } = useCompass();
  const [open, setOpen] = useState(false);
  if (!resolved) return null;
  const current = resolved.projects.find((p) => p.id === projectId);
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: theme.space["8"],
      }}
    >
      {/* The active org in its brand, and the switch for a person in several orgs (Section 4.5.7). */}
      <OrgSwitcher />
      <Button
        testID="project-picker"
        variant="secondary"
        icon="map-pin"
        label={current?.name ?? t("compass.common.chooseProject")}
        onPress={() => setOpen(true)}
      />
      <Sheet
        open={open}
        title={t("compass.common.project")}
        closeLabel={t("compass.common.close")}
        onClose={() => setOpen(false)}
      >
        {resolved.projects.map((p) => (
          <ListRow
            key={p.id}
            testID={`project-${p.id}`}
            title={p.name}
            icon={p.id === projectId ? "check" : "map-pin"}
            onPress={() => {
              setProjectId(p.id);
              setOpen(false);
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}

/**
 * Said once, after the offline storage could not be read and was replaced (src/data/localDatabase.ts):
 * changes made offline that had not uploaded are gone. Stays until dismissed, across launches.
 */
export function StorageResetNotice(): ReactElement | null {
  const { t } = useTranslation();
  const { storageNotice, dismissStorageNotice } = useCompass();
  if (!storageNotice) return null;
  return (
    <Banner
      testID="storage-reset-notice"
      tone="warning"
      icon="triangle-alert"
      message={t("compass.startup.storageReset")}
      onDismiss={dismissStorageNotice}
      dismissLabel={t("ui.action.dismiss")}
    />
  );
}

/** Offline state, queue count and decisions waiting, always visible at the top of the tabs. */
export function SyncBanner(): ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter();
  const { status, network, lastRefresh } = useCompass();
  // The queue count changes in place, so it is announced (A23-004); the first reading is not.
  const previous = useRef<number | null>(null);
  const queued = status?.queued ?? null;
  useEffect(() => {
    if (queued === null) return;
    const change = queueAnnouncement(previous.current, queued);
    previous.current = queued;
    if (change) announce(t(change.key, change.count === undefined ? {} : { count: change.count }));
  }, [queued, t]);
  if (!status) return null;
  if (status.authRequired) {
    return (
      <Banner
        testID="sync-auth"
        tone="danger"
        icon="key-round"
        message={t("compass.sync.authRequired")}
      />
    );
  }
  if (status.conflicts > 0) {
    return (
      <Banner
        testID="sync-conflicts"
        tone="danger"
        icon="triangle-alert"
        message={t(countKey("compass.sync.conflicts", status.conflicts), {
          count: status.conflicts,
        })}
        actionLabel={t("compass.sync.view")}
        onAction={() => router.push("/offline-queue")}
      />
    );
  }
  if (!status.online) {
    return (
      <OfflineBanner
        testID="sync-offline"
        message={t("compass.sync.offline")}
        queued={status.queued}
        queuedLabel={t(countKey("compass.sync.queued", status.queued), { count: status.queued })}
        viewLabel={t("compass.sync.view")}
        onView={() => router.push("/offline-queue")}
      />
    );
  }
  if (status.queued > 0) {
    return (
      <Banner
        testID="sync-queued"
        icon="refresh-cw"
        message={t(countKey("compass.sync.queued", status.queued), { count: status.queued })}
        actionLabel={t("compass.sync.view")}
        onAction={() => router.push("/offline-queue")}
      />
    );
  }
  if (network.isConnected && lastRefresh && lastRefresh.failed.length > 0) {
    return (
      <Banner
        testID="sync-refresh-failed"
        tone="warning"
        message={t("compass.sync.refreshFailed", {
          tables: lastRefresh.failed
            .map((f) =>
              t(`compass.sync.tables.${f.table}`, {
                defaultValue: t("compass.sync.tables.other"),
              }),
            )
            .join(", "),
        })}
      />
    );
  }
  return null;
}

export function LoadError({
  what,
  onRetry,
}: {
  readonly what: string;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ErrorState
      title={t("compass.states.errorTitle")}
      sentence={t("compass.states.errorSentence", { what })}
      actionLabel={t("compass.common.retry")}
      onRetry={onRetry}
    />
  );
}

export { formatDay, formatTime } from "../domain/schedule-time";

/**
 * The canon job title for a shift (xpms.role, cached as the roles canon table), so a shift reads
 * "Head Arena / Festival Rigger" rather than its role code. Falls back to the code while canon loads.
 */
export function useRoleTitle(): (shift: {
  readonly job_title?: string | null;
  readonly role_code?: string | null;
}) => string {
  const { rows } = useRows<{ id: string; job_title?: string | null }>("roles");
  return (shift) =>
    shift.job_title ??
    rows.find((r) => r.id === shift.role_code)?.job_title ??
    shift.role_code ??
    "";
}
