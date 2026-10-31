import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { TemplateAuth } from "@/components/ui";

/** Share links open on the Auth template (Section 11.6): one card, no shell, no session needed. */
export default async function ShareLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("shell.atlas");
  return (
    <main id="content" className="min-h-dvh">
      <TemplateAuth
        brand={<span className="text-heading-20 font-semibold text-text-primary">{t("name")}</span>}
      >
        {children}
      </TemplateAuth>
    </main>
  );
}
