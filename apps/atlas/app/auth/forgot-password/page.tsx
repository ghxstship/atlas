import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "@/components/auth/password-reset-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.forgotPassword");
  return { title: t("title") };
}

/** Forgot password: one Email field that emails a reset link (lib/auth/recovery.ts). */
export default async function ForgotPasswordPage() {
  const t = await getTranslations("shell.auth.forgotPassword");
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
        <p className="m-0 text-text-13 text-text-secondary">{t("lead")}</p>
      </div>
      <ForgotPasswordForm />
    </div>
  );
}
