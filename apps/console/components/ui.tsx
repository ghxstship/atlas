"use client";

/**
 * The client boundary for @xos/ui. Its components use hooks and context, so server components import them from
 * here, never from "@xos/ui" directly.
 */
import { applyTheme, buttonClass, type ButtonProps } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useEffect, type ReactNode } from "react";

export {
  Banner,
  Button,
  Checkbox,
  InlineAlert,
  Input,
  Select,
  Tag,
  Textarea,
  XOSProvider,
} from "@xos/ui";

/** Follows the operating system theme (Section 11.6): the console renders System, Dark or Light. */
export function ThemeFollower() {
  useEffect(() => applyTheme("system"), []);
  return null;
}

/** A link styled as an @xos/ui Button. */
export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  children: ReactNode;
}) {
  return (
    <NextLink href={href as Route} className={buttonClass(variant ?? "secondary", size ?? "md")}>
      {children}
    </NextLink>
  );
}
