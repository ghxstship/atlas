import { getMyOrganization } from "@xos/data";
import { getRecoveryCodeStatus } from "@xos/data/account-security";
import { getAssurance, getOrgAuthStatus, listSecondFactors } from "@xos/data/auth-assurance";
import { ShieldCheck } from "lucide-react";
import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { EnrollToContinue } from "@/components/auth/security/enroll-to-continue";
import { SecondFactorChallenge } from "@/components/auth/security/second-factor-challenge";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { safeNext } from "@/lib/auth/redirect";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authSecurity.challenge");
  return { title: t("title") };
}

/**
 * The second factor after the first (Section 9, A77). The proxy sends a person here when they hold a verified
 * second factor the session has not passed, or when an org's security.mfa_policy asks one of their role. With a
 * factor they verify it; without one, an org that requires it has them set one up; then they continue to `next`.
 */
export default async function SecondFactorPage({ searchParams }: PageProps<"/auth/mfa">) {
  const query = await searchParams;
  const next = safeNext(query["next"]);
  const viewer = await getViewer();
  if (!viewer) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const [factors, assurance, codes] = await Promise.all([
    listSecondFactors(viewer.db),
    getAssurance(viewer.db),
    getRecoveryCodeStatus(viewer.db),
  ]);
  if (!factors.ok) throw new Error(`Cannot list second factors: ${JSON.stringify(factors.error)}`);
  const verified = factors.data.filter((f) => f.verified);
  const slug = z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/)
    .safeParse(query["org"]);
  const org =
    slug.success && viewer.person
      ? await getMyOrganization(viewer.db, viewer.person.id, slug.data)
      : null;
  const t = await getTranslations("authSecurity");

  if (verified.length === 0) {
    const status = org?.ok ? await getOrgAuthStatus(viewer.db, org.data.id) : null;
    if (!org?.ok || !status?.ok || !status.data?.mfaRequired) redirect(next as Route);
    return (
      <div className="flex flex-col gap-16">
        <ShieldCheck aria-hidden="true" className="size-32 text-text-tertiary" />
        <h1 className="text-heading-20 font-semibold">{t("policy.enrollTitle")}</h1>
        <p className="m-0 text-text-14 text-text-secondary">
          {t("policy.enrollSentence", { org: org.data.name })}
        </p>
        <EnrollToContinue next={next} />
        <SignOut label={t("challenge.signOut")} />
      </div>
    );
  }

  if (assurance.ok && assurance.data.current === "aal2") redirect(next as Route);
  return (
    <div className="flex flex-col gap-16">
      <ShieldCheck aria-hidden="true" className="size-32 text-text-tertiary" />
      <h1 className="text-heading-20 font-semibold">{t("challenge.title")}</h1>
      {org?.ok ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("factors.required", { org: org.data.name })}
        </p>
      ) : null}
      <SecondFactorChallenge
        options={{
          factors: verified.map((f) => ({ id: f.id, type: f.type, label: f.label })),
          securityKeys: relyingPartyFrom(env()) !== null,
          recoveryCodes: codes.ok && codes.data.usable,
        }}
        mode="sign-in"
        next={next}
      />
      <p className="m-0 text-text-12 text-text-secondary">{t("challenge.lost")}</p>
      <SignOut label={t("challenge.signOut")} />
    </div>
  );
}

function SignOut({ label }: { label: string }) {
  return (
    <form method="post" action="/auth/sign-out">
      <button
        type="submit"
        className="min-h-touch-min text-text-13 font-medium text-accent-text underline"
      >
        {label}
      </button>
    </form>
  );
}
