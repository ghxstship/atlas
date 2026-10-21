import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignInForm } from "@/components/auth/forms";
import { ProviderButtons } from "@/components/auth/providers";
import { PasskeySignInButton } from "@/components/auth/security/passkey-sign-in";
import { InlineAlert } from "@/components/ui";
import { authErrorKey, isAuthNotice } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.signIn");
  return { title: t("title") };
}

/**
 * Sign in: OAuth providers, then one Email field whose primary action emails a sign-in link and whose
 * password signs in second (Section 11.10, rule 12; A59-025).
 */
export default async function SignInPage({ searchParams }: PageProps<"/auth/sign-in">) {
  const query = await searchParams;
  const next = safeNext(query["next"]);
  const t = await getTranslations("shell.auth");
  const tSecurity = await getTranslations("authSecurity");
  const error = typeof query["error"] === "string" ? authErrorKey({ code: query["error"] }) : null;
  const signUpHref =
    next === "/" ? "/auth/sign-up" : `/auth/sign-up?next=${encodeURIComponent(next)}`;
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("signIn.title")}</h1>
      {query["signedOut"] === undefined && error ? (
        <InlineAlert tone={isAuthNotice(error) ? "info" : "danger"}>
          {t(`errors.${error}`)}
        </InlineAlert>
      ) : null}
      <ProviderButtons next={next} />
      <PasskeySignInButton next={next} />
      <SignInForm next={next} />
      <Link
        href={
          (next === "/" ? "/auth/sso" : `/auth/sso?next=${encodeURIComponent(next)}`) as "/auth/sso"
        }
        className="text-text-13 text-accent-text underline"
      >
        {tSecurity("sso.link")}
      </Link>
      <p className="text-text-13 text-text-secondary">
        {t("signIn.noAccount")}{" "}
        <Link href={signUpHref as "/auth/sign-up"} className="text-accent-text underline">
          {t("signIn.toSignUp")}
        </Link>
      </p>
    </div>
  );
}
