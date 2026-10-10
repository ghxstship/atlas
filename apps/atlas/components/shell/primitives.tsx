import type { Route } from "next";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Minimum shell primitives composed from the token classes of the XOS Tailwind preset, used until
 * the matching @xos/ui components land on main (A05, Wave 2): Button and ButtonLink stand in for
 * @xos/ui Button, PageHeader for PageHeader. Replace each with its @xos/ui counterpart when it
 * merges; the props follow design/xos-design-system/components/index.d.ts.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-text-on hover:opacity-hover",
  secondary: "border border-border-control bg-bg-surface text-text-primary hover:bg-bg-hover",
  ghost: "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
  danger: "bg-danger text-danger-text-on hover:opacity-hover",
};

const BASE =
  "inline-flex h-control-md items-center justify-center gap-6 rounded-control px-12 text-label-13 font-medium transition-colors duration-fast disabled:opacity-disabled disabled:cursor-not-allowed";

export function buttonClass(variant: Variant = "secondary", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return <button type="button" className={buttonClass(variant, className)} {...props} />;
}

export function ButtonLink({
  href,
  variant = "secondary",
  className = "",
  children,
}: {
  href: Route;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant, className)}>
      {children}
    </Link>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="flex min-h-row-comfortable items-center justify-between gap-12 border-b border-border-subtle px-24 py-12">
      <h1 className="text-heading-20 font-semibold text-text-primary">{title}</h1>
      {actions ? <div className="flex items-center gap-8">{actions}</div> : null}
    </header>
  );
}
