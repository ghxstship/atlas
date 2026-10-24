/**
 * Add to Apple Wallet or Google Wallet (Section 11.10 item 14; A65-011 part 4), under the person's own badge
 * or shift. iOS shows Apple's own Add to Apple Wallet button; Android a Compass button for Google Wallet.
 * Nothing shows where the device has no wallet.
 */
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { AddPassButton } from "../../modules/compass-wallet";
import { walletLabels, type WalletKind } from "../domain/wallet";
import { useCompass } from "../runtime/CompassProvider";
import { addToWallet, deviceWallet } from "../runtime/wallet";
import { Button, InlineAlert, useTheme } from "../ui";

export function WalletButton({
  kind,
  id,
  testID,
}: {
  readonly kind: WalletKind;
  readonly id: string;
  readonly testID?: string;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { client, config } = useCompass();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const wallet = deviceWallet();
  if (!wallet) return null;
  const add = () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void addToWallet(client, config.supabaseUrl, kind, id, i18n.language, walletLabels(t))
      .then((key) => setProblem(key ? t(key) : null))
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: theme.space["8"] }}>
      {wallet === "apple" && AddPassButton ? (
        <AddPassButton
          testID={testID}
          accessibilityHint={t("compass.wallet.addApple")}
          onPress={add}
          style={{ height: theme.density.touchMin, opacity: busy ? theme.opacity.disabled : 1 }}
        />
      ) : (
        <Button
          {...(testID ? { testID } : {})}
          variant="secondary"
          icon="wallet"
          block
          label={busy ? t("compass.wallet.adding") : t("compass.wallet.addGoogle")}
          onPress={add}
        />
      )}
      {problem ? <InlineAlert tone="warning" message={problem} /> : null}
    </View>
  );
}
