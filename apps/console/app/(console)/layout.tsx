import { chromeSlot } from "@xos/ia";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { ConsoleNav } from "@/components/console-nav";
import { Button } from "@/components/ui";
import { sitemap } from "@/ia/sitemap.generated";
import { getConsoleFormat } from "@/lib/format";
import { getConsoleContext } from "@/lib/operator";

const SITEMAP_ROLE = {
  Support: "support",
  "Trust and Safety": "trust-and-safety",
  Administrator: "administrator",
} as const;

/**
 * Every console page renders inside this shell, and only for a live operator with a second factor in this session
 * (lib/operator.ts). The top bar lists the sections the operator's role uses (ia/sitemap.yaml); the database checks
 * each action again.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const ctx = await getConsoleContext();
  const [{ t }, nav] = await Promise.all([getConsoleFormat(), getTranslations("nav")]);
  const items = chromeSlot(sitemap, "topBar", { role: SITEMAP_ROLE[ctx.operator.role] }).map(
    (node) => ({
      href: node.route ?? "/",
      label: (nav as unknown as (k: string) => string)(node.label.replace(/^nav\./, "")),
    }),
  );
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-8 focus:top-8 focus:rounded-control focus:bg-bg-raised focus:p-8"
      >
        {t("skipToContent")}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-12 border-b border-border-subtle bg-bg-surface px-16 py-8">
        <div className="flex flex-wrap items-center gap-16">
          <span className="text-text-14 font-semibold">{t("name")}</span>
          <ConsoleNav label={t("mainNav")} items={items} />
        </div>
        <div className="flex items-center gap-12">
          <span className="text-text-13 text-text-secondary" data-testid="operator">
            {t("signedInAs", {
              name: ctx.operator.fullName ?? ctx.operator.email ?? t("common.unknownPerson"),
              role: t(`roles.${ctx.operator.role}`),
            })}
          </span>
          <form action="/auth/sign-out" method="post">
            <Button type="submit" variant="ghost" size="sm">
              {t("signOut")}
            </Button>
          </form>
        </div>
      </header>
      <main
        id="main"
        className="mx-auto flex w-full max-w-screen-xl flex-1 flex-col gap-24 px-16 py-24"
      >
        {children}
      </main>
    </div>
  );
}
