import type { Row } from "@xos/sync";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  answer,
  buildInspection,
  criticalFailures,
  FAIL_CODE,
  goTo,
  isComplete,
  PASS_CODE,
  progress,
  startWalk,
  type InspectionItem,
  type ResultValue,
  type Walk,
} from "../../src/domain/inspections";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { Gate } from "../../src/screens/common";
import { PhotoSheet } from "../../src/screens/PhotoSheet";
import {
  Button,
  ChecklistRunner,
  EmptyState,
  InlineAlert,
  Screen,
  TextField,
  useTheme,
} from "../../src/ui";

/** One item per card, large Pass and Fail, a Fail asks for a photo and a note (Section 11.13 Inspections). */
function WalkScreen({ templateId }: { readonly templateId: string }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { projectId, resolved, engine, status } = useCompass();
  const { rows: items } = useRows<InspectionItem & Row & { inspection_template_id: string }>(
    "inspection_items",
    (i) => i.inspection_template_id === templateId,
  );
  const { rows: values } = useRows<ResultValue & Row>("inspection_result_values");
  const { rows: templates } = useRows<Row & { name: string }>(
    "inspection_templates",
    (tpl) => tpl.id === templateId,
  );
  const [walk, setWalk] = useState<Walk | null>(null);
  const [failing, setFailing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const current = useMemo(
    () =>
      walk ??
      (items.length > 0 && projectId && resolved?.orgId
        ? startWalk(resolved.orgId, templateId, projectId, items, Date.now())
        : null),
    [walk, items, projectId, resolved?.orgId, templateId],
  );
  const pass = values.find((v) => v.code === PASS_CODE);
  const fail = values.find((v) => v.code === FAIL_CODE);
  if (!current || !pass || !fail) {
    return (
      <EmptyState
        testID="walk-empty"
        icon="clipboard-check"
        sentence={t("compass.inspections.empty")}
        actionLabel={t("compass.common.back")}
        onAction={() => router.back()}
      />
    );
  }
  const { done, total } = progress(current);
  const record = (itemId: string, resultId: string, n = "", p: string | null = null) =>
    setWalk(
      answer(current, itemId, { resultId, note: n, photoUri: p, answeredAt: Date.now() }, values),
    );
  const submit = async () => {
    if (!engine) return;
    const [first, ...rest] = buildInspection(current, Date.now());
    if (!first) return;
    const head = await engine.outbox.enqueue(first);
    for (const w of rest) await engine.outbox.enqueue({ ...w, dependsOn: [head.id] });
    void engine.drain();
    router.replace({
      pathname: "/inspections",
      params: { done: status?.online ? "sent" : "queued" },
    });
  };
  const failures = criticalFailures(current, values);
  return (
    <Screen
      testID="inspection-walk"
      title={templates[0]?.name ?? t("compass.inspections.title")}
      footer={
        isComplete(current) ? (
          <Button
            testID="inspection-submit"
            size="lg"
            block
            label={t("compass.inspections.submit")}
            onPress={() => void submit()}
          />
        ) : undefined
      }
    >
      <ChecklistRunner
        testID="checklist"
        title={t("compass.inspections.progress", { done, total })}
        index={Math.min(current.index, total - 1)}
        items={current.items.map((i) => ({
          code: i.id,
          label: i.prompt,
          result: current.answers[i.id]
            ? current.answers[i.id]?.resultId === fail.id
              ? "fail"
              : "pass"
            : null,
        }))}
        onResult={(code, result) => {
          if (result === "pass") record(code, pass.id);
          else {
            setFailing(code);
            setNote("");
            setPhoto(null);
            setMissing([]);
          }
        }}
        onIndexChange={(index) => setWalk(goTo(current, index))}
        failDetail={
          failing ? (
            <View style={{ gap: theme.space["12"] }}>
              <TextField
                testID="fail-note"
                label={t("compass.inspections.failNote")}
                value={note}
                onChangeText={setNote}
                multiline
                {...(missing.includes("note")
                  ? { error: t("compass.inspections.failNoteMissing") }
                  : {})}
              />
              <Button
                testID="fail-photo"
                variant="secondary"
                icon="camera"
                label={t(
                  photo ? "compass.inspections.failPhotoRetake" : "compass.inspections.failPhoto",
                )}
                onPress={() => setPhotoOpen(true)}
              />
              {photo ? (
                <InlineAlert
                  testID="fail-photo-added"
                  tone="success"
                  message={t("compass.inspections.failPhotoAdded")}
                />
              ) : null}
              {missing.includes("photo") ? (
                <InlineAlert tone="danger" message={t("compass.inspections.failPhotoMissing")} />
              ) : null}
              <Button
                testID="fail-save"
                variant="danger"
                label={t("compass.inspections.saveFail")}
                onPress={() => {
                  const gaps = [...(note.trim() ? [] : ["note"]), ...(photo ? [] : ["photo"])];
                  setMissing(gaps);
                  if (gaps.length > 0) return;
                  record(failing, fail.id, note, photo);
                  setFailing(null);
                }}
              />
            </View>
          ) : undefined
        }
        labels={{
          pass: t("compass.inspections.pass"),
          fail: t("compass.inspections.fail"),
          progress: t("compass.inspections.progress", { done, total }),
          previous: t("compass.common.previous"),
          next: t("compass.common.next"),
        }}
      />
      {failures.length > 0 ? (
        <InlineAlert
          tone="danger"
          message={t("compass.inspections.criticalFailures", { count: failures.length })}
        />
      ) : null}
      <PhotoSheet open={photoOpen} onClose={() => setPhotoOpen(false)} onPhoto={setPhoto} />
    </Screen>
  );
}

export default function InspectionWalk(): ReactElement {
  const { templateId } = useLocalSearchParams<{ templateId: string }>();
  return (
    <Gate feature="inspections.perform">
      <WalkScreen templateId={templateId ?? ""} />
    </Gate>
  );
}
