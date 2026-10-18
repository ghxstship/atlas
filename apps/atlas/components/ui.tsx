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
