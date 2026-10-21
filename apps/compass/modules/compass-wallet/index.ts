/**
 * Apple Wallet (A65-011 part 4): the add-pass sheet and Apple's Add to Apple Wallet button. Absent on
 * Android and in tests, so callers get null; Android adds passes through the Google Wallet link instead.
 */
import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";

export interface CompassWalletModule {
  canAddPasses(): boolean;
  /** Shows Wallet's add-pass sheet for a signed .pkpass, base64. */
  addPass(base64: string): Promise<boolean>;
}

export const CompassWallet = requireOptionalNativeModule<CompassWalletModule>("CompassWallet");

export interface AddPassButtonProps extends ViewProps {
  readonly onPress: () => void;
}

/** Apple's Add to Apple Wallet button, or null where the module is absent. */
export const AddPassButton: ComponentType<AddPassButtonProps> | null = CompassWallet
  ? requireNativeView<AddPassButtonProps>("CompassWallet")
  : null;
