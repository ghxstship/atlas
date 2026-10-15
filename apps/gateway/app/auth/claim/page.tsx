import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ButtonLink, Icon, InlineAlert } from "@/components/ui";
import { requireContext } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.claim");
  return { title: t("title") };
}

/**
 * Account claim after a token flow (Section 4.4.6, journey 50): advance forms and signatures done
 * with a token join the account whose verified email received the link. The claim RPC belongs to
 * the token service (A10 advance tokens, A28b document tokens); until it is connected the page
 * says so plainly and sends the person Home, so nothing pretends to succeed.
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
      <p className="m-0 text-text-14 text-text-secondary">
        {t("body", { email: ctx.email ?? "" })}
      </p>
      <InlineAlert tone="info">{t("unavailable")}</InlineAlert>
      <ButtonLink href="/home" variant="primary">
        {t("home")}
      </ButtonLink>
    </div>
  );
}
