"use client";

/**
 * The client boundary for @xos/ui (A05). Its components use hooks and context, so server
 * components import them from here, never from "@xos/ui" directly. The wrappers below adapt
 * callback props (onAction) to links, because server components can only pass serializable props.
 */
import { buttonClass, EmptyState, type ButtonProps } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export {
  AppShell,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  CommandMenu,
  Dialog,
  DropdownMenu,
  InlineAlert,
  Input,
  OrgSwitcher,
  PageHeader,
  ScrollRegion,
  Select,
  Sidebar,
  Switch,
  TabBar,
  TemplateAuth,
  TemplateDashboard,
  TemplateSettings,
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

/**
 * A file download styled as an @xos/ui Button: a plain anchor with `download`, because a route
 * handler answers it with a file, not a page Next.js could prefetch (generated documents, ADR 0031).
 */
export function DownloadLink({
  href,
  variant = "secondary",
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  children: ReactNode;
}) {
  return (
    <a href={href} download className={buttonClass(variant ?? "secondary", "sm")}>
      {children}
    </a>
  );
}

/** @xos/ui EmptyState whose one action navigates (Section 11.10, rule 10). */
export function EmptyStateLink(props: {
  sentence: string;
  actionLabel: string;
  icon?: string;
  href: string;
  /** The page header already holds this primary action, so the button is secondary (gate 27). */
  secondary?: boolean;
}) {
  const router = useRouter();
  return (
    <EmptyState
      sentence={props.sentence}
      actionLabel={props.actionLabel}
      {...(props.icon ? { icon: props.icon } : {})}
      {...(props.secondary ? { actionVariant: "secondary" as const } : {})}
      onAction={() => router.push(props.href as Route)}
    />
  );
}
