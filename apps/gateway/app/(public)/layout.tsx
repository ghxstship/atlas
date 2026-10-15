import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { BrandMark } from "@/components/ui";
import { getGatewayContext, getRequestFacts } from "@/lib/shell/context";

/**
 * Public and token pages (Section 4.5.8: public profiles, the ranking explanation, advance forms
 * and signing links). They render without a session in the org's brand on its custom domain, with
 * one way back: Home for a signed-in person, sign in for everyone else.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const [t, facts, ctx] = await Promise.all([
    getTranslations(),
    getRequestFacts(),
    getGatewayContext(),
  ]);
  const name = facts.brand.kind === "org" ? facts.brand.org.name : t("shell.gateway.name");
  return (
    <div className="flex min-h-dvh flex-col bg-bg-canvas">
      <header className="flex h-(--ui-topnav) items-center justify-between gap-12 border-b border-border-subtle bg-bg-surface px-16 md:px-24">
        <BrandMark name={name} size="sm" />
        <Link
          href={(ctx ? "/home" : "/auth/sign-in") as Route}
          className="inline-flex min-h-touch-min items-center text-text-13 font-medium text-accent-text"
        >
          {ctx ? t("nav.gateway.primary.home") : t("gateway.auth.signUp.toSignIn")}
        </Link>
      </header>
      <main id="content" className="mx-auto flex w-full max-w-layout-reading flex-1 flex-col gap-16 p-16 md:p-24">
        {children}
      </main>
    </div>
  );
}
