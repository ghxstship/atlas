import type {
  AgencySlateProps as ReferenceAgencySlateProps,
  ApplicationFormProps as ReferenceApplicationFormProps,
  AvailabilityCalendarProps as ReferenceAvailabilityCalendarProps,
  EngagementTimelineProps as ReferenceEngagementTimelineProps,
  EPKViewerProps as ReferenceEPKViewerProps,
  OnboardingPacketProps as ReferenceOnboardingPacketProps,
  OpportunityCardProps as ReferenceOpportunityCardProps,
  OpportunityFiltersProps as ReferenceOpportunityFiltersProps,
  PaymentTrackerProps as ReferencePaymentTrackerProps,
  PayoutDetailsFormProps as ReferencePayoutDetailsFormProps,
  ProfileEditorProps as ReferenceProfileEditorProps,
  ProgressBarProps as ReferenceProgressBarProps,
  RatingDialogProps as ReferenceRatingDialogProps,
  UpNextCardProps as ReferenceUpNextCardProps,
} from "../types/reference";

export type ProgressBarProps = ReferenceProgressBarProps;

export type OpportunityCardProps = ReferenceOpportunityCardProps & {
  onApply?: () => void;
  onSave?: () => void;
};

export type OpportunityFiltersProps = ReferenceOpportunityFiltersProps & {
  onSearch?: (query: string) => void;
  onChipsChange?: (active: string[]) => void;
  onViewChange?: (view: "cards" | "map") => void;
};

export type ApplicationFormProps = ReferenceApplicationFormProps & { onSubmit?: () => void };

export type AgencySlateProps = ReferenceAgencySlateProps & {
  onChange?: (selected: string[]) => void;
  onSubmit?: (selected: string[]) => void;
};

export type ProfileEditorProps = ReferenceProfileEditorProps & {
  onVisibilityChange?: (label: string, visibility: "private" | "application" | "public") => void;
};

export type EPKViewerProps = ReferenceEPKViewerProps & { onMedia?: (label: string) => void };

export type AvailabilityCalendarProps = ReferenceAvailabilityCalendarProps;

export type OnboardingPacketProps = ReferenceOnboardingPacketProps & {
  onStart?: (label: string) => void;
};

export type EngagementTimelineProps = ReferenceEngagementTimelineProps;

export type RatingDialogProps = ReferenceRatingDialogProps & {
  onSubmit?: (rating: number, comment: string) => void;
  onLater?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export type PayoutDetailsFormProps = ReferencePayoutDetailsFormProps & {
  onSave?: (details: { routing: string; account: string; type: string }) => void;
};

export type PaymentTrackerProps = ReferencePaymentTrackerProps;

export type UpNextCardProps = ReferenceUpNextCardProps & {
  onDirections?: () => void;
  onCalendar?: () => void;
  onWallet?: () => void;
};
