import { uuidv7, type Row } from "@xos/sync";
import { useRouter } from "expo-router";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { samplingPlan } from "../../src/domain/geo";
import {
  buildReport,
  draftProblems,
  isCritical,
  newDraft,
  withIncidentDependency,
  type IncidentDraft,
  type Severity,
} from "../../src/domain/incidents";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import { useLocation } from "../../src/runtime/location";
import { Gate } from "../../src/screens/common";
import { PhotoSheet } from "../../src/screens/PhotoSheet";
import {
  Button,
  InlineAlert,
  QuickIncidentSheet,
  Screen,
  Text,
  TextField,
  useTheme,
} from "../../src/ui";

/** CAD-style quick report in three steps (Section 11.13 Incidents), filed offline when needed. */
function Report(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { resolved, projectId, engine, status } = useCompass();
  const { rows: severities } = useRows<Severity & Row>("incident_severities");
  const ordered = useMemo(
    () => [...severities].sort((a, b) => a.sortOrder - b.sortOrder),
    [severities],
  );
  const { fix } = useLocation(
    samplingPlan({
      battery: { level: 1, charging: false, lowPowerMode: false },
      onShift: true,
      minutesToCall: null,
      punching: true,
      batterySaver: false,
    }),
  );
  const [draft, setDraft] = useState<IncidentDraft>(() =>
    newDraft(resolved?.orgId ?? "", projectId ?? "", new Date().toISOString(), null, Date.now()),
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withFix = { ...draft, fix: draft.fix ?? fix };
  const problems = draftProblems(withFix);
  const location = withFix.fix
    ? t("compass.incidents.locationAuto", {
        latitude: withFix.fix.latitude.toFixed(5),
        longitude: withFix.fix.longitude.toFixed(5),
        accuracy: Math.round(withFix.fix.accuracyM),
      })
    : t("compass.incidents.locationUnknown");
  const submit = async () => {
    if (!engine || problems.length > 0) return;
    try {
      const writes = buildReport(withFix, Date.now());
      const [first, ...rest] = writes;
      if (!first) return;
      const incident = await engine.outbox.enqueue(first);
      for (const w of withIncidentDependency([first, ...rest], incident.id))
        await engine.outbox.enqueue(w);
      void engine.drain();
      router.replace({
        pathname: "/incidents",
        params: { filed: status?.online ? "sent" : "queued" },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Screen testID="incident-new" title={t("compass.incidents.new")}>
      <QuickIncidentSheet
        testID="incident-sheet"
        types={ordered.map((s) => ({
          key: s.id,
          label: s.label,
          icon: isCritical(s, ordered) ? "siren" : s.sortOrder <= 2 ? "triangle-alert" : "info",
          critical: isCritical(s, ordered),
        }))}
        location={location}
        step={step}
        {...(draft.severityId ? { selected: draft.severityId } : {})}
        onSelectType={(key) => {
          setDraft({ ...draft, severityId: key });
          setStep(2);
        }}
        attachments={
          <View style={{ gap: theme.space["12"] }}>
            <TextField
              testID="incident-title"
              label={t("compass.incidents.titleLabel")}
              help={t("compass.incidents.titleHelp")}
              value={draft.title}
              onChangeText={(title) => setDraft({ ...draft, title })}
              {...(problems.includes("title-too-long")
                ? { error: t("compass.incidents.titleTooLong") }
                : {})}
            />
            <Text tone="secondary">
              {t("compass.incidents.photoCount", { count: draft.photos.length })}
            </Text>
            <Button
              testID="incident-photo"
              variant="secondary"
              icon="camera"
              label={t("compass.incidents.addPhoto")}
              onPress={() => setPhotoOpen(true)}
            />
          </View>
        }
        submitLabel={t("compass.incidents.submit")}
        holdHint={t("compass.incidents.holdHint")}
        onSubmit={() => void submit()}
        labels={{
          step: t("compass.incidents.step", { step }),
          location: t("compass.incidents.location"),
          change: t("compass.incidents.change"),
          typeGroup: t("compass.incidents.typeGroup"),
        }}
      />
      {step === 2 ? (
        <Button
          testID="incident-next"
          size="lg"
          block
          label={t("compass.common.next")}
          onPress={() => setStep(3)}
        />
      ) : null}
      {step > 1 ? (
        <Button
          variant="ghost"
          label={t("compass.common.back")}
          onPress={() => setStep(step === 3 ? 2 : 1)}
        />
      ) : null}
      {step === 3 && problems.includes("title-missing") ? (
        <InlineAlert tone="info" message={t("compass.incidents.titleMissing")} />
      ) : null}
      {error ? <InlineAlert tone="danger" message={error} /> : null}
      <PhotoSheet
        open={photoOpen}
        onClose={() => setPhotoOpen(false)}
        onPhoto={(uri) =>
          setDraft({
            ...draft,
            photos: [...draft.photos, { id: uuidv7(), uri, capturedAt: new Date().toISOString() }],
          })
        }
      />
    </Screen>
  );
}

export default function NewIncident(): ReactElement {
  return (
    <Gate feature="incidents.report">
      <Report />
    </Gate>
  );
}
