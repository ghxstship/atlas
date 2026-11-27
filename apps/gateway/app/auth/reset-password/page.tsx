import { tokenAal } from "@xos/data/auth-assurance";
import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NewPasswordForm } from "@/components/auth/password-reset-forms";
import { ButtonLink, Icon } from "@/components/ui";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { FORGOT_PASSWORD_PATH, recoveryIsFresh, RESET_PASSWORD_PATH } from "@/lib/auth/recovery";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.resetPassword");
  return { title: t("title") };
}

/**
 * The page a reset link opens, after /auth/callback exchanged its code (lib/auth/recovery.ts). It shows the form only
 * to a session that came from a reset link in the last half hour; anyone else reads that the link no longer works and
 * can ask for a new one. A person who holds a second factor passes it first: Gateway's proxy guards only sitemap
 * routes, so this page sends them to /auth/mfa itself.
 */
export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/auth/reset-password">) {
  const done = (await searchParams)["done"] !== undefined;
  const t = await getTranslations("gateway.auth.resetPassword");
  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  const user = auth.user;
  const { data: current } = user ? await db.auth.getSession() : { data: { session: null } };
  const token = current.session?.access_token;
  if (user && (user.factors ?? []).some((f) => f.status === "verified")) {
    if (tokenAal(token) === "aal1")
      redirect(secondFactorRedirect(RESET_PASSWORD_PATH, "") as Route);
  }

  if (user && done) {
    return (
      <div className="flex flex-col items-center gap-16 text-center">
        <span className="text-text-tertiary">
          <Icon name="CircleCheck" size={32} />
        </span>
        <h1 className="text-heading-20 font-semibold">{t("doneTitle")}</h1>
        <p className="text-text-14 text-text-secondary">{t("doneBody")}</p>
        <ButtonLink href="/home">{t("continue")}</ButtonLink>
      </div>
    );
  }

  if (!user || !recoveryIsFresh(token, Date.now())) {
    return (
      <div className="flex flex-col items-center gap-16 text-center">
        <span className="text-text-tertiary">
          <Icon name="CircleAlert" size={32} />
        </span>
        <h1 className="text-heading-20 font-semibold">{t("expiredTitle")}</h1>
        <p className="text-text-14 text-text-secondary">{t("expiredBody")}</p>
        <ButtonLink href={FORGOT_PASSWORD_PATH}>{t("requestNew")}</ButtonLink>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("lead", { email: user.email ?? "" })}
        </p>
      </div>
      <NewPasswordForm email={user.email ?? ""} />
    </div>
  );
}
