import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignUpForm } from "@/components/auth/forms";
import { ProviderButtons } from "@/components/auth/providers";
import { safeNext } from "@/lib/auth/redirect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.signUp");
  return { title: t("title") };
}

/**
 * Create an account. Without a `next` (an invitation link sets one), a new account goes on to
 * create its organization, where the Owner accepts the Terms of Service and the DPA.
 */
export default async function SignUpPage({ searchParams }: PageProps<"/auth/sign-up">) {
  const next = safeNext((await searchParams)["next"], "/auth/organization");
  const t = await getTranslations("shell.auth");
  const signInHref = `/auth/sign-in?next=${encodeURIComponent(next)}`;
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("signUp.title")}</h1>
      <ProviderButtons next={next} />
      <SignUpForm next={next} />
      <p className="text-text-13 text-text-secondary">
        {t("signUp.haveAccount")}{" "}
        <Link href={signInHref as "/auth/sign-in"} className="text-accent-text underline">
          {t("signUp.toSignIn")}
        </Link>
      </p>
    </div>
  );
}
