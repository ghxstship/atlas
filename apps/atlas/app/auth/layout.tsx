import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

/** The Auth template (Section 11.6): a centered 400 px card on the brand background. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("shell.atlas");
  return (
    <div className="flex min-h-dvh flex-col items-center bg-bg-canvas px-16 py-64">
      <p className="mb-24 text-heading-20 font-semibold text-text-primary">{t("name")}</p>
      <main
        id="content"
        className="w-full max-w-layout-auth rounded-card border border-border-subtle bg-bg-surface p-24"
      >
        {children}
      </main>
    </div>
  );
}
