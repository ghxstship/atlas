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
 * The signed-in person, whether they still owe their second factor, and whether the session opened a reset link
 * recently enough to choose a password (lib/auth/recovery.ts).
 */
async function resetSession() {
  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  const user = auth.user;
  if (!user) return { user: null, owesSecondFactor: false, fresh: false };
  const { data: current } = await db.auth.getSession();
  const token = current.session?.access_token;
  const holdsFactor = (user.factors ?? []).some((f) => f.status === "verified");
  return {
    user,
    owesSecondFactor: holdsFactor && tokenAal(token) === "aal1",
    fresh: recoveryIsFresh(token, Date.now()),
  };
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
  const { user, owesSecondFactor, fresh } = await resetSession();
  if (owesSecondFactor) redirect(secondFactorRedirect(RESET_PASSWORD_PATH, "") as Route);

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

  if (!user || !fresh) {
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
