/**
 * Takes one receipt photo with the camera (A92), compressed and re-encoded for upload and for Aurora. It asks for the
 * camera with the same sentence as Scan, and the shutter follows the org's sounds setting, as field photos do.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { soundsOn } from "../domain/settings";
import { useCompass } from "../runtime/CompassProvider";
import { processReceipt, type ReceiptImage } from "../runtime/receipts";
import { Button, InlineAlert, Sheet, Text, useTheme } from "../ui";

export function ReceiptCamera({
  open,
  onClose,
  onImage,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onImage: (image: ReceiptImage) => void;
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
      onImage(await processReceipt(shot.uri, shot.width, shot.height));
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
      title={t("compassExpenses.camera.title")}
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
      <Text variant="text13" tone="secondary">
        {t("compassExpenses.camera.hint")}
      </Text>
      {error ? (
        <InlineAlert tone="danger" message={t("compass.photo.failed", { reason: error })} />
      ) : null}
      <Button
        testID="receipt-take"
        size="lg"
        block
        icon="camera"
        loading={busy}
        disabled={!permission?.granted}
        label={t("compassExpenses.camera.take")}
        onPress={() => void take()}
      />
    </Sheet>
  );
}
