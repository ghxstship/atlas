import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MagicLinkForm, SignUpForm } from "@/components/auth/forms";
import { Divider, ProviderButtons } from "@/components/auth/providers";
import { safeNext } from "@/lib/auth/redirect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.signUp");
  return { title: t("title") };
}

/**
 * Create an account. External people need no organization: the account is the person's, global
 * across tenants (Section 4.4.1). A token flow sends `next` to /auth/claim so finished
 * submissions join the new account (Section 4.4.6).
 */
export default async function SignUpPage({ searchParams }: PageProps<"/auth/sign-up">) {
  const next = safeNext((await searchParams)["next"], "/home");
  const t = await getTranslations("gateway.auth");
  const signInHref = `/auth/sign-in?next=${encodeURIComponent(next)}`;
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-20 font-semibold">{t("signUp.title")}</h1>
        <p className="m-0 text-text-13 text-text-secondary">{t("signUp.lead")}</p>
      </div>
      <ProviderButtons next={next} />
      <MagicLinkForm next={next} intent="sign-up" />
      <Divider />
      <SignUpForm next={next} />
      <p className="m-0 text-text-13 text-text-secondary">
        {t("signUp.haveAccount")}{" "}
        <Link href={signInHref as "/auth/sign-in"} className="text-accent-text underline">
          {t("signUp.toSignIn")}
        </Link>
      </p>
    </div>
  );
}
