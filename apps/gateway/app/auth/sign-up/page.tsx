import type { Metadata, Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignUpForm } from "@/components/auth/forms";
import { ProviderButtons } from "@/components/auth/providers";
import { safeNext } from "@/lib/auth/redirect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.signUp");
  return { title: t("title") };
}

/**
 * Create an account. External people need no organization: the account is the person's, global
 * across tenants (Section 4.4.1). The person accepts the Worker Terms and reads the Privacy Policy
 * before the account exists (Section 14.4, finding A59-025); both open in a new tab so nothing typed
 * is lost. A token flow sends `next` to /auth/claim so finished submissions join the new account
 * (Section 4.4.6).
 */
export default async function SignUpPage({ searchParams }: PageProps<"/auth/sign-up">) {
  const query = await searchParams;
  const next = safeNext(query["next"], "/home");
  const t = await getTranslations("gateway.auth");
  const signInHref = `/auth/sign-in?next=${encodeURIComponent(next)}`;
  const legalLink = (href: string) =>
    function LegalLink(chunks: React.ReactNode) {
      return (
        <Link
          href={href as Route}
          target="_blank"
          rel="noopener"
          className="text-accent-text underline"
        >
          {chunks}
        </Link>
      );
    };
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-20 font-semibold">{t("signUp.title")}</h1>
        <p className="m-0 text-text-13 text-text-secondary">{t("signUp.lead")}</p>
      </div>
      <ProviderButtons next={next} />
      <SignUpForm
        next={next}
        initial={query["method"] === "password" ? "password" : "link"}
        termsLabel={t.rich("signUp.terms", {
          terms: legalLink("/legal/worker-terms"),
          privacy: legalLink("/legal/privacy-policy"),
        })}
      />
      <p className="m-0 text-text-13 text-text-secondary">
        {t("signUp.haveAccount")}{" "}
        <Link href={signInHref as "/auth/sign-in"} className="text-accent-text underline">
          {t("signUp.toSignIn")}
        </Link>
      </p>
    </div>
  );
}
