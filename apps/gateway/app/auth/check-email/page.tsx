import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { ButtonLink, Icon } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.checkEmail");
  return { title: t("title") };
}

/** After a magic link or a sign-up that needs confirmation. */
export default async function CheckEmailPage({ searchParams }: PageProps<"/auth/check-email">) {
  const email = z.email().safeParse((await searchParams)["email"]);
  const t = await getTranslations("gateway.auth.checkEmail");
  return (
    <div className="flex flex-col items-center gap-16 text-center">
      <span className="text-text-tertiary">
        <Icon name="MailCheck" size={32} />
      </span>
      <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
      <p className="text-text-14 text-text-secondary">
        {email.success ? t("body", { email: email.data }) : t("bodyNoEmail")}
      </p>
      <ButtonLink href="/auth/sign-in">{t("back")}</ButtonLink>
    </div>
  );
}
