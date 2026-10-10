import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The Atlas application shell: skip link, navigation chrome and the main region. Stands in for
 * @xos/ui AppShell until it lands on main.
 */
export async function AppShell({ ctx, children }: { ctx: OrgContext; children: ReactNode }) {
  const t = await getTranslations("shell.page");
  return (
    <div className="flex min-h-dvh" data-org={ctx.org.slug}>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-8 focus:top-8 focus:z-toast focus:rounded-control focus:bg-bg-raised focus:px-12 focus:py-8"
      >
        {t("skipToContent")}
      </a>
      <main id="content" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
