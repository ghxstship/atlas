import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { buildProofPhoto, proofEngagement } from "../src/domain/proof";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import { ExternalPageScreen } from "../src/screens/ExternalPageScreen";
import { PhotoSheet } from "../src/screens/PhotoSheet";
import { Button, Text, useTheme } from "../src/ui";

/**
 * The proof-of-performance More screen for sponsors (Section 4.5.7, A92; src/domain/external.ts): their entitlements
 * and proof documents, and, while their engagement on the project is active, a photo of each entitlement as it is
 * delivered (A140, src/domain/proof.ts). The photo queues offline and uploads to their engagement's folder.
 */
export default function ProofOfPerformanceScreen(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { resolved, enqueue } = useCompass();
  const { rows: entitlements } = useRows<{ id: string; project_id?: string | null }>(
    "sponsor_entitlements",
  );
  const [target, setTarget] = useState<string | null>(null);
  const engagements = resolved?.identity.engagements ?? [];
  const engagementOf = (entitlementId: string) =>
    proofEngagement(engagements, entitlements.find((e) => e.id === entitlementId)?.project_id);
  const chosen = target ? engagementOf(target) : null;

  return (
    <ExternalPageScreen
      page="proof-of-performance"
      itemAction={(item, section) => {
        if (section !== "entitlements") return null;
        if (!engagementOf(item.id))
          return (
            <Text variant="text13" tone="secondary">
              {t("compassExternal.proof.noEngagement")}
            </Text>
          );
        return (
          <View style={{ alignItems: "flex-start", paddingBottom: theme.space["8"] }}>
            <Button
              testID={`proof-photo-${item.id}`}
              variant="secondary"
              icon="camera"
              label={t("compassExternal.proof.addPhoto")}
              onPress={() => setTarget(item.id)}
            />
          </View>
        );
      }}
    >
      {engagements.some((e) => e.roleType === "sponsor") ? (
        <Text variant="text13" tone="secondary">
          {t("compassExternal.proof.capture")}
        </Text>
      ) : null}
      <PhotoSheet
        open={target !== null && chosen !== null}
        onClose={() => setTarget(null)}
        onPhoto={(uri) => {
          if (!target || !chosen) return;
          void enqueue(
            buildProofPhoto(
              {
                entitlementId: target,
                engagement: chosen,
                localUri: uri,
                capturedAt: new Date().toISOString(),
              },
              Date.now(),
            ),
          );
        }}
      />
    </ExternalPageScreen>
  );
}
