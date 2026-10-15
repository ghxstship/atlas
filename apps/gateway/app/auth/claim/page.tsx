import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ClaimForm } from "@/components/tokens/claim-form";
import { Icon } from "@/components/ui";
import { requireContext } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.claim");
  return { title: t("title") };
}

/**
 * Account claim after a token flow (Section 4.4.6, journey 50): advance answers and signatures
 * given through a link sent to the person's verified email join this account
 * (app.claim_token_submissions), so they show under Work and Documents.
 */
export default async function ClaimPage() {
  const ctx = await requireContext("/auth/claim");
  const t = await getTranslations("gateway.auth.claim");
  return (
    <div className="flex flex-col gap-16">
      <span className="text-text-tertiary">
        <Icon name="Link2" size={28} />
      </span>
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("body", { email: ctx.email ?? "" })}</p>
      <ClaimForm email={ctx.email ?? ""} />
    </div>
  );
}
