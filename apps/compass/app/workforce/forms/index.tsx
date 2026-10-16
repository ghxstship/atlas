import { listFormTemplates } from "@xos/data/workforce-forms";
import { useRouter } from "expo-router";
import type { ReactElement } from "react";
import { Card, EmptyState, ErrorState, ListRow, Screen, Skeleton } from "../../../src/ui";
import { useCompass } from "../../../src/runtime/CompassProvider";
import { cachedRead } from "../../../src/workforce/cache";
import { useT, WorkforceGate } from "../../../src/workforce/kit";
import { useLoad, useWorkforce } from "../../../src/workforce/runtime";

/** Published forms (Atlas knowledge.forms); each opens in the FormFillScreen, ready offline. */
function Forms(): ReactElement {
  const t = useT();
  const router = useRouter();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const { store } = useCompass();
  const loaded = useLoad(
    orgId
      ? () => cachedRead(store, `form_templates:${orgId}`, () => listFormTemplates(wf.db, orgId))
      : null,
    [orgId, store],
  );
  const published = (loaded.data ?? []).filter((f) => f.state === "Published");
  return (
    <Screen
      testID="workforce-forms"
      title={t("workforce.compass.hub.forms")}
      refreshing={loaded.refreshing}
      onRefresh={loaded.refresh}
    >
      {loaded.status === "loading" ? (
        <Skeleton lines={3} />
      ) : loaded.status === "error" ? (
        <ErrorState
          title={t("workforce.compass.common.errorTitle")}
          sentence={t("workforce.compass.common.errorSentence")}
          actionLabel={t("workforce.compass.common.retry")}
          onRetry={loaded.refresh}
        />
      ) : published.length === 0 ? (
        <EmptyState
          sentence={t("workforce.compass.hub.formsEmpty")}
          actionLabel={t("workforce.compass.common.refresh")}
          onAction={loaded.refresh}
        />
      ) : (
        <Card>
          {published.map((f) => (
            <ListRow
              key={f.id}
              testID={`form-${f.id}`}
              icon="clipboard-check"
              title={f.name}
              {...(f.description ? { subtitle: f.description } : {})}
              onPress={() =>
                router.push({
                  pathname: "/workforce/forms/[templateId]",
                  params: { templateId: f.id },
                })
              }
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function FormsRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Forms />
    </WorkforceGate>
  );
}
