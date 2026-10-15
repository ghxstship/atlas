/**
 * The camera surface for every scan mode (expo-camera), filling the ScanSheet camera slot. It asks for
 * camera permission with a sentence that names why, and reports each code with its symbology.
 */
import { CameraView, useCameraPermissions, type BarcodeType } from "expo-camera";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SUPPORTED_CAMERA_TYPES, symbologyOf, type Symbology } from "../domain/scan";
import { Button, Text, useTheme } from "../ui";

export function Scanner({
  onCode,
  active = true,
}: {
  readonly onCode: (raw: string, symbology: Symbology | null) => void;
  readonly active?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const [permission, request] = useCameraPermissions();
  if (!permission?.granted) {
    return (
      <View
        testID="camera-permission"
        style={{
          flex: 1,
          padding: theme.space["24"],
          gap: theme.space["16"],
          justifyContent: "center",
          backgroundColor: theme.color.cameraBg,
        }}
      >
        <Text tone="secondary">{t("compass.scan.cameraPermission")}</Text>
        <Button
          testID="camera-allow"
          label={t("compass.scan.allowCamera")}
          onPress={() => void request()}
        />
      </View>
    );
  }
  return (
    <CameraView
      testID="camera"
      style={{ flex: 1 }}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: SUPPORTED_CAMERA_TYPES as BarcodeType[] }}
      {...(active
        ? {
            onBarcodeScanned: (result: { data: string; type: string }) =>
              onCode(result.data, symbologyOf(result.type)),
          }
        : {})}
    />
  );
}
