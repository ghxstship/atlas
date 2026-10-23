import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/ui";

/** 404 for unknown pages and for pages the operator's role does not use (ADR 0003: never 403). */
export default async function NotFound() {
  const t = await getTranslations("console.notFound");
  return (
    <main className="mx-auto flex max-w-prose flex-col gap-12 px-16 py-48">
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("body")}</p>
      <div>
        <ButtonLink href="/tenants">{t("action")}</ButtonLink>
      </div>
    </main>
  );
}
