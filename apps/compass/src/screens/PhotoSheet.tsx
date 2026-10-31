/**
 * Takes one field photo with the camera, compressed for upload, keeping where it was taken only when the org keeps
 * photo location. Used by incident reports, failed inspection items and sponsors' proof-of-performance photos, whose
 * screen passes the entitlement's org's rule as `settings` (a sponsor has no org settings of their own).
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { soundsOn, type ResolvedValues } from "../domain/settings";
import { useCompass } from "../runtime/CompassProvider";
import { processPhoto, wantsExif } from "../runtime/media";
import { Button, InlineAlert, Sheet, Text, useTheme } from "../ui";

export function PhotoSheet({
  open,
  onClose,
  onPhoto,
  settings,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPhoto: (uri: string) => void;
  /** The values the photo is taken with; the org's resolved settings when absent. */
  readonly settings?: ResolvedValues;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const camera = useRef<CameraView>(null);
  const [permission, request] = useCameraPermissions();
  const { orgSettings } = useCompass();
  const values = settings ?? orgSettings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = async () => {
    if (!camera.current) return;
    setBusy(true);
    setError(null);
    try {
      const shot = await camera.current.takePictureAsync({
        exif: wantsExif(values),
        quality: 0.9,
        shutterSound: soundsOn(values),
      });
      onPhoto(
        await processPhoto(shot.uri, shot.width, shot.height, {
          settings: values,
          exif: shot.exif as Record<string, unknown> | undefined,
        }),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      title={t("compass.incidents.addPhoto")}
      closeLabel={t("compass.common.close")}
      onClose={onClose}
    >
      {permission?.granted ? (
        <View
          style={{
            height: theme.space["64"] * 5,
            borderRadius: theme.radius.card,
            overflow: "hidden",
          }}
        >
          <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
        </View>
      ) : (
        <View style={{ gap: theme.space["12"] }}>
          <Text tone="secondary">{t("compass.scan.cameraPermission")}</Text>
          <Button label={t("compass.scan.allowCamera")} onPress={() => void request()} />
        </View>
      )}
      {error ? (
        <InlineAlert tone="danger" message={t("compass.photo.failed", { reason: error })} />
      ) : null}
      <Button
        testID="photo-take"
        size="lg"
        block
        icon="camera"
        loading={busy}
        disabled={!permission?.granted}
        label={t("compass.photo.take")}
        onPress={() => void take()}
      />
    </Sheet>
  );
}
