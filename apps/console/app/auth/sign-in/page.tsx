import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PasswordSignIn } from "@/components/auth-forms";
import { Button, InlineAlert } from "@/components/ui";
import { signInWithGoogleAction } from "@/lib/actions/auth";
import { shownError } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirect";
import { env, passwordSignIn } from "@/lib/env";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("console.auth");
  return { title: t("title") };
}

/**
 * Console sign-in (ADR 0046): Sign in with Google, the platform team's identity provider, and, outside production,
 * the password form the journeys use. An account off the platform team is signed out at once and told why.
 */
export default async function SignInPage({ searchParams }: PageProps<"/auth/sign-in">) {
  const query = await searchParams;
  const next = safeNext(query["next"], "/tenants");
  const error = shownError(query["error"]);
  const t = await getTranslations("console.auth");
  return (
    <>
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("intro")}</p>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <form action={signInWithGoogleAction}>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="secondary">
          {t("google")}
        </Button>
      </form>
      {passwordSignIn(env()) ? <PasswordSignIn next={next} /> : null}
    </>
  );
}
