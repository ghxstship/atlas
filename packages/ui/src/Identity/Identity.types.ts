import type {
  BrandSlotProps as ReferenceBrandSlotProps,
  CredentialBadgeProps as ReferenceCredentialBadgeProps,
  PresenceIndicatorProps as ReferencePresenceIndicatorProps,
  QRCodeProps as ReferenceQRCodeProps,
  WhiteLabelPreviewProps as ReferenceWhiteLabelPreviewProps,
} from "../types/reference";

export type PresenceIndicatorProps = ReferencePresenceIndicatorProps;

export type QRCodeProps = ReferenceQRCodeProps;

export type CredentialBadgeProps = ReferenceCredentialBadgeProps & {
  onWallet?: () => void;
  onBrightness?: () => void;
};

export type BrandSlotProps = ReferenceBrandSlotProps;

export type WhiteLabelPreviewProps = ReferenceWhiteLabelPreviewProps;

export interface QRModules {
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
