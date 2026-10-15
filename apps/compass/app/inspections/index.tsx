import type { Row } from "@xos/sync";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { buildSignOff, canSignOff } from "../../src/domain/inspections";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { formatDay, Gate, ProjectPicker, SyncBanner, useAllowed } from "../../src/screens/common";
import { Button, Card, EmptyState, InlineAlert, ListRow, Screen, Tag, Text } from "../../src/ui";

interface InspectionRow extends Row {
  readonly project_id: string;
  readonly inspection_template_id: string;
  readonly inspector_person_id: string | null;
  readonly inspected_at: string;
  readonly signed_off_at: string | null;
}

function Inspections(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { done } = useLocalSearchParams<{ done?: string }>();
  const { projectId, resolved, enqueue } = useCompass();
  const canSign = useAllowed("inspections.signOff");
  const { rows: templates } = useRows<Row & { name: string }>("inspection_templates");
  const { rows: recent } = useRows<InspectionRow>("inspections", (i) => i.project_id === projectId);
  const names = new Map(templates.map((tpl) => [tpl.id, tpl.name]));
  const personId = resolved?.identity.personId ?? "";
  return (
    <Screen testID="inspections" title={t("compass.inspections.title")}>
      <ProjectPicker />
      <SyncBanner />
      {done ? (
        <InlineAlert
          testID="inspection-done"
          tone="success"
          message={t(
            done === "sent" ? "compass.inspections.submitted" : "compass.inspections.queued",
          )}
        />
      ) : null}
      {templates.length === 0 ? (
        <EmptyState
          testID="inspections-empty"
          icon="clipboard-check"
          sentence={t("compass.inspections.empty")}
          actionLabel={t("compass.common.openAtlas")}
        />
      ) : (
        <Card title={t("compass.inspections.choose")}>
          {[...templates]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((tpl) => (
              <ListRow
                key={tpl.id}
                testID={`template-${tpl.id}`}
                icon="clipboard-check"
                title={tpl.name}
                trailing={
                  <Button
                    label={t("compass.inspections.start")}
                    onPress={() =>
                      router.push({
                        pathname: "/inspections/[templateId]",
                        params: { templateId: tpl.id },
                      })
                    }
                  />
                }
              />
            ))}
        </Card>
      )}
      {recent.length > 0 ? (
        <>
          <Text variant="heading20" heading>
            {t("compass.inspections.recent")}
          </Text>
          {[...recent]
            .sort((a, b) => b.inspected_at.localeCompare(a.inspected_at))
            .slice(0, 10)
            .map((i) => {
              const decision = canSignOff(i, personId, canSign);
              return (
                <Card
                  key={i.id}
                  title={names.get(i.inspection_template_id) ?? ""}
                  meta={
                    <Tag
                      label={t(
                        i.signed_off_at
                          ? "compass.inspections.signed"
                          : "compass.inspections.notSigned",
                      )}
                      tone={i.signed_off_at ? "success" : "warning"}
                    />
                  }
                  footer={
                    decision === "allowed" ? (
                      <Button
                        testID={`signoff-${i.id}`}
                        label={t("compass.inspections.signOff")}
                        onPress={() => void enqueue(buildSignOff(i.id, Date.now()))}
                      />
                    ) : decision === "own-inspection" ? (
                      <Text variant="text13" tone="tertiary">
                        {t("compass.inspections.signOffOwn")}
                      </Text>
                    ) : undefined
                  }
                >
                  <Text tone="secondary">{formatDay(i.inspected_at)}</Text>
                </Card>
              );
            })}
        </>
      ) : null}
    </Screen>
  );
}

export default function InspectionsScreen(): ReactElement {
  return (
    <Gate feature="inspections.perform">
      <Inspections />
    </Gate>
  );
}
