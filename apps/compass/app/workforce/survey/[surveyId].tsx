import { listSurveys } from "@xos/data/workforce-feed";
import { SurveyScreen } from "@xos/workforce-native";
import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";
import { useT, WorkforceGate } from "../../../src/workforce/kit";
import { surveyLabels } from "../../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../../src/workforce/runtime";

/** One pulse survey, answered offline and sent through app.respond_to_survey. */
function Survey(): ReactElement {
  const t = useT();
  const { surveyId } = useLocalSearchParams<{ surveyId: string }>();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(orgId ? () => listSurveys(wf.db, orgId, wf.myMembershipIds) : null, [
    orgId,
    surveyId,
  ]);
  const survey = loaded.data?.find((s) => s.id === surveyId) ?? null;
  return (
    <SurveyScreen
      status={loaded.status}
      labels={surveyLabels(t, survey?.title ?? t("workforce.compass.hub.surveys"))}
      survey={survey}
      onRespond={(id, answers) =>
        wf.queue("respond_to_survey", { p_survey_id: id, p_answers: answers })
      }
      onRetry={loaded.refresh}
      {...(loaded.errorReference ? { errorReference: loaded.errorReference } : {})}
    />
  );
}

export default function SurveyRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Survey />
    </WorkforceGate>
  );
}
