/**
 * Pieces every Compass screen shares: the access gate with its refusal state, the project header picker,
 * the always-visible sync banner and the loading and error states.
 */
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { access, type Denial, type Feature } from "../domain/access";
import { queueAnnouncement } from "../domain/announce";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { countKey } from "../runtime/i18n";
import {
  announce,
  Banner,
  Button,
  ErrorState,
  ListRow,
  OfflineBanner,
  RefusalNotice,
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

/** Renders children only when the signed-in person may use the feature on the current project. */
export function Gate({
  feature,
  children,
}: {
  readonly feature: Feature;
  readonly children: ReactNode;
}): ReactElement {
  const { resolved, projectId } = useCompass();
  if (!resolved) return <Skeleton lines={3} />;
  const decision = access(resolved.identity, feature, projectId);
  return decision.allowed ? <>{children}</> : <DenialNotice reason={decision.reason} />;
}

export function useAllowed(feature: Feature): boolean {
  const { resolved, projectId } = useCompass();
  return resolved ? access(resolved.identity, feature, projectId).allowed : false;
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
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

export function formatTime(iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatDay(iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

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
