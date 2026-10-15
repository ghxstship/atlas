import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { BrandMark, TemplateAuth } from "@/components/ui";
import { getRequestFacts } from "@/lib/shell/context";

/**
 * The Auth template (Section 11.6): a centered 400 px card on the brand background, in the org's
 * brand on its custom Gateway domain (Section 4.4.7, trust signals in Section 11.12).
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const [t, facts] = await Promise.all([getTranslations("shell.gateway"), getRequestFacts()]);
  const name = facts.brand.kind === "org" ? facts.brand.org.name : t("name");
  return (
    <main id="content" className="min-h-dvh">
      <TemplateAuth brand={<BrandMark name={name} />}>{children}</TemplateAuth>
    </main>
  );
}
