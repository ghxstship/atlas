import type { Row } from "@xos/sync";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  buildTransition,
  dispatchQueue,
  type IncidentRow,
  type Severity,
} from "../../src/domain/incidents";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { formatTime, Gate, ProjectPicker, SyncBanner, useAllowed } from "../../src/screens/common";
import { Button, Card, EmptyState, InlineAlert, Screen, Tag, Text } from "../../src/ui";

/** Incident log for the project, with dispatch actions for supervisors (Section 4.3 item 5). */
function Incidents(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { filed } = useLocalSearchParams<{ filed?: string }>();
  const { projectId, enqueue } = useCompass();
  const canDispatch = useAllowed("incidents.dispatch");
  const { rows: incidents } = useRows<IncidentRow & Row & { project_id: string }>(
    "incidents",
    (i) => i.project_id === projectId,
  );
  const { rows: severities } = useRows<Severity & Row>("incident_severities");
  const label = new Map(severities.map((s) => [s.id, s.label]));
  const queue = dispatchQueue(incidents, severities);
  return (
    <Screen
      testID="incidents"
      title={t("compass.incidents.title")}
      footer={
        <Button
          testID="incident-report"
          size="lg"
          block
          variant="danger"
          icon="siren"
          label={t("compass.incidents.new")}
          onPress={() => router.push("/incidents/new")}
        />
      }
    >
      <ProjectPicker />
      <SyncBanner />
      {filed ? (
        <InlineAlert
          testID="incident-filed"
          tone="success"
          message={t(filed === "sent" ? "compass.incidents.sent" : "compass.incidents.queued")}
        />
      ) : null}
      {queue.length === 0 ? (
        <EmptyState
          testID="incidents-empty"
          icon="shield-alert"
          sentence={t("compass.incidents.empty")}
          actionLabel={t("compass.incidents.new")}
          onAction={() => router.push("/incidents/new")}
        />
      ) : (
        queue.map((i) => (
          <Card
            key={i.id}
            testID={`incident-${i.id}`}
            title={i.title}
            meta={
              <Tag
                label={t(`compass.incidents.states.${i.incident_state}`)}
                tone={i.incident_state === "Reported" ? "danger" : "warning"}
              />
            }
            footer={
              canDispatch && i.incident_number !== null ? (
                i.incident_state === "Reported" ? (
                  <Button
                    label={t("compass.incidents.dispatch")}
                    onPress={() =>
                      void enqueue(
                        buildTransition(i, "Dispatched", t("compass.incidents.dispatchReason")),
                      )
                    }
                  />
                ) : i.incident_state === "Dispatched" ? (
                  <Button
                    variant="secondary"
                    label={t("compass.incidents.contain")}
                    onPress={() =>
                      void enqueue(
                        buildTransition(i, "Contained", t("compass.incidents.containReason")),
                      )
                    }
                  />
                ) : undefined
              ) : undefined
            }
          >
            <Text tone="secondary">
              {label.get(i.severity_enum_id) ?? ""}
              {" · "}
              {formatTime(i.occurred_at)}
            </Text>
            <Text variant="text13" tone="tertiary">
              {i.incident_number !== null && i.incident_number !== undefined
                ? t("compass.incidents.number", { number: i.incident_number })
                : t("compass.incidents.unnumbered")}
            </Text>
          </Card>
        ))
      )}
    </Screen>
  );
}

export default function IncidentsScreen(): ReactElement {
  return (
    <Gate feature="incidents.report">
      <Incidents />
    </Gate>
  );
}
