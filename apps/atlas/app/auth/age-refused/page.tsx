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
 * owner stops deletion for now, so they are told to contact us. The session has already ended. Every outcome links home,
 * the Privacy Policy and the Legal Contact page, so the page is never a dead end.
 */
export default async function AgeRefusedPage({ searchParams }: PageProps<"/auth/age-refused">) {
  const outcome = (await searchParams)["outcome"];
  const t = await getTranslations("shell.auth.ageRefused");
  const sentence = outcome === "closed" ? "closed" : outcome === "held" ? "held" : "sentence";
  return (
    <div className="flex flex-col gap-16">
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14">{t(sentence)}</p>
      {outcome === "held" ? null : (
        <p className="m-0 text-text-13 text-text-secondary">{t("minors")}</p>
      )}
      {/* A way on from a page that ends the session (crawl 4.9): home, what XOS does with what was typed, and someone
          to ask. Deliberately no way back to the age question, which a neutral age screen does not invite. */}
      <nav aria-label={t("linksLabel")}>
        <ul className="m-0 flex list-none flex-wrap gap-x-16 gap-y-8 p-0 text-text-14">
          <li>
            <Link href={"/" as Route} className="text-accent-text underline">
              {t("home")}
            </Link>
          </li>
          <li>
            <Link href={"/legal/privacy-policy" as Route} className="text-accent-text underline">
              {t("privacy")}
            </Link>
          </li>
          <li>
            <Link href={"/legal/contact" as Route} className="text-accent-text underline">
              {t("contact")}
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
