import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MagicLinkForm, PasswordSignInForm } from "@/components/auth/forms";
import { Divider, ProviderButtons } from "@/components/auth/providers";
import { InlineAlert } from "@/components/ui";
import { authErrorKey } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.signIn");
  return { title: t("title") };
}

/** Sign in: OAuth providers and the magic link first, password last (Section 11.10, rule 12). */
export default async function SignInPage({ searchParams }: PageProps<"/auth/sign-in">) {
  const query = await searchParams;
  const next = safeNext(query["next"]);
  const t = await getTranslations("shell.auth");
  const error = typeof query["error"] === "string" ? authErrorKey({ code: query["error"] }) : null;
  const signUpHref =
    next === "/" ? "/auth/sign-up" : `/auth/sign-up?next=${encodeURIComponent(next)}`;
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("signIn.title")}</h1>
      {query["signedOut"] === undefined && error ? (
        <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert>
      ) : null}
      <ProviderButtons next={next} />
      <MagicLinkForm next={next} intent="sign-in" />
      <Divider />
      <PasswordSignInForm next={next} />
      <p className="text-text-13 text-text-secondary">
        {t("signIn.noAccount")}{" "}
        <Link href={signUpHref as "/auth/sign-up"} className="text-accent-text underline">
          {t("signIn.toSignUp")}
        </Link>
      </p>
    </div>
  );
}
