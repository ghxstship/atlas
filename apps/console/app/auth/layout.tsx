import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

/** The auth template: one centered card with the console's name. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("console");
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-24 px-16 py-48">
      <p className="m-0 text-text-14 font-semibold">{t("name")}</p>
      <div className="flex flex-col gap-16 rounded-card border border-border-subtle bg-bg-surface p-24">
        {children}
      </div>
    </main>
  );
}
