/**
 * Mounting helpers for the Workforce screens: the gate (Workforce Suite screens are for org members;
 * external parties hold no membership), the project requirement of the site operations screens and the
 * frame props every screen shares.
 */
import { isInternal } from "@xos/sync";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../runtime/CompassProvider";
import { DenialNotice, ProjectPicker } from "../screens/common";
import { EmptyState, Screen, Skeleton } from "../ui";
import type { T } from "./labels";
import type { Loaded } from "./runtime";

export function useT(): T {
  const { t } = useTranslation();
  return t as unknown as T;
}

/** Workforce screens are for members of the org (Section 4.9); externals get the role notice. */
export function WorkforceGate({
  children,
  needsProject = false,
}: {
  readonly children: ReactNode;
  readonly needsProject?: boolean;
}): ReactElement {
  const t = useT();
  const { resolved, projectId } = useCompass();
  if (!resolved) {
    return (
      <Screen>
        <Skeleton lines={3} />
      </Screen>
    );
  }
  if (!isInternal(resolved.identity.audience) || !resolved.identity.membershipId) {
    return (
      <Screen>
        <DenialNotice reason="role" />
      </Screen>
    );
  }
  if (needsProject && !projectId) {
    return (
      <Screen>
        <ProjectPicker />
        <EmptyState
          testID="workforce-no-project"
          icon="map-pin"
          sentence={t("workforce.compass.common.noProject")}
          actionLabel={t("workforce.compass.common.chooseProject")}
        />
      </Screen>
    );
  }
  return <>{children}</>;
}

/** The status, refresh and retry props every Workforce screen takes. */
export function frameProps<D>(loaded: Loaded<D>): {
  status: Loaded<D>["status"];
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  errorReference?: string;
} {
  return {
    status: loaded.status,
    refreshing: loaded.refreshing,
    onRefresh: loaded.refresh,
    onRetry: loaded.refresh,
    ...(loaded.errorReference ? { errorReference: loaded.errorReference } : {}),
  };
}
