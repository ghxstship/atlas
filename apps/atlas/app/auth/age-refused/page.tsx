import type { Metadata, Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.ageRefused");
  return { title: t("title") };
}

/**
 * What someone who answered under 18 is told (ADR 0156). Without an outcome they answered on a sign-up form, so no account
 * was made. `closed` means their account is gone, and `held` that a legal hold, an open shift or being an org's only
 * owner stops deletion for now, so they are told to contact us. The session has already ended.
 */
export default async function AgeRefusedPage({ searchParams }: PageProps<"/auth/age-refused">) {
  const outcome = (await searchParams)["outcome"];
  const t = await getTranslations("shell.auth.ageRefused");
  const sentence = outcome === "closed" ? "closed" : outcome === "held" ? "held" : "sentence";
  return (
    <div className="flex flex-col gap-16">
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14">{t(sentence)}</p>
      {outcome === "held" ? (
        <p className="m-0 text-text-14">
          <Link href={"/legal/contact" as Route} className="text-accent-text underline">
            {t("contact")}
          </Link>
        </p>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("minors")}</p>
      )}
    </div>
  );
}
