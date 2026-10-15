"use client";

/**
 * The client boundary for @xos/ui. Its components use hooks and context, so server components
 * import them from here, never from "@xos/ui" directly. The wrappers below adapt callback props
 * (onAction) to links, because server components can only pass serializable props.
 */
import {
  applyTheme,
  buttonClass,
  EmptyState,
  ErrorState,
  RefusalNotice,
  TemplateSystem,
  type ButtonProps,
} from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

export {
  AvailabilityCalendar,
  Avatar,
  Badge,
  BrandMark,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  EngagementTimeline,
  EPKViewer,
  Icon,
  Gallery,
  InlineAlert,
  Input,
  OnboardingPacket,
  PageHeader,
  PaymentTracker,
  ProgressBar,
  PropertyList,
  Select,
  Skeleton,
  StatTile,
  Tag,
  TemplateAuth,
  TemplateSettings,
  Textarea,
  UpNextCard,
  XOSProvider,
} from "@xos/ui";

/** A link styled as an @xos/ui Button. */
export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  children: ReactNode;
}) {
  return (
    <NextLink
      href={href as Route}
      className={`${buttonClass(variant ?? "secondary", size ?? "md")} ${className ?? ""}`.trim()}
    >
      {children}
    </NextLink>
  );
}

/** @xos/ui TemplateSystem whose one action navigates. */
export function SystemPage(props: {
  icon: string;
  title: string;
  sentence: string;
  actionLabel: string;
  href: string;
}) {
  const router = useRouter();
  return (
    <TemplateSystem
      icon={props.icon}
      title={props.title}
      sentence={props.sentence}
      actionLabel={props.actionLabel}
      onAction={() => router.push(props.href as Route)}
    />
  );
}

/** @xos/ui EmptyState whose one action navigates (Section 11.10, rule 10). */
export function EmptyStateLink(props: {
  sentence: string;
  actionLabel: string;
  icon?: string;
  href: string;
}) {
  const router = useRouter();
  return (
    <EmptyState
      sentence={props.sentence}
      actionLabel={props.actionLabel}
      {...(props.icon ? { icon: props.icon } : {})}
      onAction={() => router.push(props.href as Route)}
    />
  );
}

/** @xos/ui ErrorState for a region whose data did not load; retry reloads the route. */
export function LoadError(props: { title: string; sentence: string; actionLabel: string }) {
  const router = useRouter();
  return (
    <ErrorState
      title={props.title}
      sentence={props.sentence}
      actionLabel={props.actionLabel}
      onRetry={() => router.refresh()}
    />
  );
}

/** @xos/ui RefusalNotice whose action navigates to the place that resolves it. */
export function RefusalLink(props: {
  title: string;
  reason: string;
  actionLabel: string;
  href: string;
}) {
  const router = useRouter();
  return (
    <RefusalNotice
      outcome="REFUSE"
      title={props.title}
      reason={props.reason}
      actionLabel={props.actionLabel}
      onAction={() => router.push(props.href as Route)}
    />
  );
}

/** Follows the operating system theme while the preference is System (Section 11.6). */
export function ThemeFollower() {
  useEffect(() => applyTheme("system"), []);
  return null;
}
