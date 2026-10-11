import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { TemplateAuth } from "@/components/ui";

/** The Auth template (Section 11.6): a centered 400 px card on the brand background. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
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
