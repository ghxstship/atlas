import { listSurveys } from "@xos/data/workforce-feed";
import { useRouter } from "expo-router";
import type { ReactElement } from "react";
import { Card, EmptyState, ErrorState, ListRow, Screen, Skeleton, Tag } from "../../src/ui";
import { useT, WorkforceGate } from "../../src/workforce/kit";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/** Open pulse surveys (Atlas knowledge.feed); each opens in the SurveyScreen. */
function Surveys(): ReactElement {
  const t = useT();
  const router = useRouter();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(orgId ? () => listSurveys(wf.db, orgId, wf.myMembershipIds) : null, [
    orgId,
    wf.syncTick,
  ]);
  const open = (loaded.data ?? []).filter((s) => s.state === "Open");
  return (
    <Screen
      testID="workforce-surveys"
      title={t("workforce.compass.hub.surveys")}
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
      ) : open.length === 0 ? (
        <EmptyState
          sentence={t("workforce.compass.hub.surveysEmpty")}
          actionLabel={t("workforce.compass.common.refresh")}
          onAction={loaded.refresh}
        />
      ) : (
        <Card>
          {open.map((s) => (
            <ListRow
              key={s.id}
              testID={`survey-${s.id}`}
              title={s.title}
              {...(s.description ? { subtitle: s.description } : {})}
              {...(s.respondedByMe
                ? {
                    trailing: (
                      <Tag tone="success" label={t("workforce.compass.survey.submitted")} />
                    ),
                  }
                : {})}
              onPress={() =>
                router.push({
                  pathname: "/workforce/survey/[surveyId]",
                  params: { surveyId: s.id },
                })
              }
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function SurveysRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Surveys />
    </WorkforceGate>
  );
}
