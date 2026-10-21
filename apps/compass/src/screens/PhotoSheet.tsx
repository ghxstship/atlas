/**
 * Takes one field photo with the camera, compressed for upload. Used by incident reports and failed
 * inspection items.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { soundsOn } from "../domain/settings";
import { useCompass } from "../runtime/CompassProvider";
import { processPhoto } from "../runtime/media";
import { Button, InlineAlert, Sheet, Text, useTheme } from "../ui";

export function PhotoSheet({
  open,
  onClose,
  onPhoto,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPhoto: (uri: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const camera = useRef<CameraView>(null);
  const [permission, request] = useCameraPermissions();
  const { orgSettings } = useCompass();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = async () => {
    if (!camera.current) return;
    setBusy(true);
    setError(null);
    try {
      const shot = await camera.current.takePictureAsync({
        exif: false,
        quality: 0.9,
        shutterSound: soundsOn(orgSettings),
      });
      onPhoto(await processPhoto(shot.uri, shot.width, shot.height));
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
