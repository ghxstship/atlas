import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One tile of a B6 dashboard (Home > Today, Show > Show day): a titled section with an optional link
 * and actions, rendered on the server so a tile adds no client code of its own.
 */
export function DashboardTileFrame({
  id,
  title,
  link,
  actions,
  children,
}: {
  id: string;
  title: string;
  link?: { readonly href: string; readonly label: string } | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex h-full flex-col gap-12 rounded-card border border-border-subtle bg-bg-surface p-16"
    >
      <header className="flex flex-wrap items-center justify-between gap-8">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <span className="flex flex-wrap items-center gap-8">
          {actions}
          {link ? (
            <Link href={link.href as Route} className="text-text-13 text-accent-text underline">
              {link.label}
            </Link>
          ) : null}
        </span>
      </header>
      {children}
    </section>
  );
}
