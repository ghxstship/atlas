import { getFormTemplate } from "@xos/data/workforce-forms";
import { uuidv7 } from "@xos/sync";
import { FormFillScreen } from "@xos/workforce-native";
import { useLocalSearchParams } from "expo-router";
import { useRef, useState, type ReactElement } from "react";
import { samplingPlan } from "../../../src/domain/geo";
import { useCompass } from "../../../src/runtime/CompassProvider";
import { useLocation } from "../../../src/runtime/location";
import { PhotoSheet } from "../../../src/screens/PhotoSheet";
import { cachedRead } from "../../../src/workforce/cache";
import { useT, WorkforceGate } from "../../../src/workforce/kit";
import { formLabels } from "../../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../../src/workforce/runtime";
import { buildFormSubmission, formMediaPath } from "../../../src/workforce/writes";

/**
 * Journey 65: a form built in Atlas, filled in Compass with or without signal. Conditional fields,
 * required photos and the signature pad come from FormFillScreen; the template is kept on the device
 * after its first read, photos and the signature upload before app.submit_form replays, and the server
 * files the submission as a record of the template's kind.
 */
function FormFill(): ReactElement {
  const t = useT();
  const { templateId } = useLocalSearchParams<{ templateId: string }>();
  const { store, enqueue } = useCompass();
  const wf = useWorkforce(t);
  const loaded = useLoad(
    () =>
      cachedRead(store, `form_template:${templateId}`, () => getFormTemplate(wf.db, templateId)),
    [templateId, store],
  );
  const template = loaded.data ?? null;
  const { fix, permission } = useLocation(
    samplingPlan({
      battery: { level: 1, charging: false, lowPowerMode: false },
      onShift: true,
      minutesToCall: null,
      punching: template?.requiresLocation === true,
      batterySaver: false,
    }),
  );
  const photos = useRef(new Map<string, string>());
  const [capture, setCapture] = useState<{ resolve: (path: string | null) => void } | null>(null);
  const location = !template?.requiresLocation
    ? ""
    : fix
      ? t("workforce.compass.forms.locationStamped", {
          latitude: fix.latitude.toFixed(5),
          longitude: fix.longitude.toFixed(5),
        })
      : permission === "denied"
        ? t("workforce.compass.forms.locationOff")
        : t("workforce.compass.forms.locating");

  return (
    <>
      <FormFillScreen
        status={loaded.status}
        labels={formLabels(t, template?.name ?? t("workforce.compass.hub.forms"), location)}
        template={template}
        onCapturePhoto={() => new Promise<string | null>((resolve) => setCapture({ resolve }))}
        onSubmit={async (answers, signature) => {
          if (!wf.orgId || !wf.personId || !template) {
            return { ok: false, message: t("workforce.compass.common.unexpected") };
          }
          const named = JSON.stringify(answers);
          try {
            await enqueue(
              buildFormSubmission(
                {
                  orgId: wf.orgId,
                  personId: wf.personId,
                  templateId: template.id,
                  answers,
                  projectId: wf.projectId,
                  location:
                    template.requiresLocation && fix
                      ? {
                          latitude: fix.latitude,
                          longitude: fix.longitude,
                          accuracyM: fix.accuracyM,
                        }
                      : null,
                  signature: signature ? { signerName: wf.displayName, svgPath: signature } : null,
                  // Only the photos the shown answers still name travel with the submission.
                  photos: [...photos.current]
                    .filter(([path]) => named.includes(path))
                    .map(([storagePath, localUri]) => ({ storagePath, localUri })),
                },
                Date.now(),
              ),
            );
            photos.current.clear();
            return { ok: true };
          } catch (error) {
            console.error("Form submission could not be queued", error);
            return { ok: false, message: t("workforce.compass.common.unexpected") };
          }
        }}
        onRetry={loaded.refresh}
        {...(loaded.errorReference ? { errorReference: loaded.errorReference } : {})}
      />
      <PhotoSheet
        open={capture !== null}
        onClose={() => {
          capture?.resolve(null);
          setCapture(null);
        }}
        onPhoto={(uri) => {
          if (!wf.orgId || !wf.personId) {
            capture?.resolve(null);
          } else {
            const path = formMediaPath(wf.orgId, wf.personId, `${uuidv7(Date.now())}.jpg`);
            photos.current.set(path, uri);
            capture?.resolve(path);
          }
          setCapture(null);
        }}
      />
    </>
  );
}

export default function FormFillRoute(): ReactElement {
  return (
    <WorkforceGate>
      <FormFill />
    </WorkforceGate>
  );
}
