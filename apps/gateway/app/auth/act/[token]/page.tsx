import {
  isActionToken,
  readActionLink,
  readSignedOutApprovalLink,
} from "@xos/data/notification-actions";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionLinkForm } from "@/components/tokens/action-link-form";
import { SignedOutApproval } from "@/components/tokens/signed-out-approval";
import { Icon, InlineAlert } from "@/components/ui";
import { getGatewayContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.actionLink");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * The confirm page of a one-tap email link in Gateway (A127, ADR 0106; Section 11.10 rule 5): an engaged worker's
 * shift or an applicant's offer, accepted with one more press after the email's button. Opening it only reads what
 * the link does; someone else's link says nothing about itself, and a member's link (sent for Atlas, where the org's
 * security settings apply) says only that it opens in Atlas. Signed out, the person signs in and comes back here,
 * except an outside approver whose engagement step lets them decide from email (P9, ADR 0138): their link shows what it
 * does and decides with a code emailed on demand, without a sign-in.
 */
export default async function ActionLinkPage({ params }: PageProps<"/auth/act/[token]">) {
  const { token } = await params;
  const next = isActionToken(token) ? `/auth/act/${token}` : "/home";
  const ctx = await getGatewayContext();
  const [t, tr] = await Promise.all([getTranslations("gateway.auth.actionLink"), getTranslate()]);
  if (!ctx) {
    const signedOut = isActionToken(token)
      ? await readSignedOutApprovalLink(await createServerSupabase(), token)
      : null;
    const link = signedOut?.ok ? signedOut.data : null;
    // Any other link, a member's included, needs a sign-in as before (A127).
    if (!link || link.state === "sign_in" || link.state === "invalid" || link.action === null)
      redirect(`/auth/sign-in?next=${encodeURIComponent(next)}`);
    return (
      <div className="flex flex-col gap-16">
        <span className="text-text-tertiary">
          <Icon name="MailCheck" size={28} />
        </span>
        <h1 className="m-0 text-heading-20 font-semibold">
          {tr(`gateway.auth.actionLink.signedOut.heading.${link.action}`)}
        </h1>
        {link.orgName ? (
          <p className="m-0 text-text-14 text-text-secondary">{t("org", { org: link.orgName })}</p>
        ) : null}
        {link.maskedEmail ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t("signedOut.codeGoesTo", { email: link.maskedEmail })}
          </p>
        ) : null}
        {link.state === "ready" ? (
          <SignedOutApproval token={token} action={link.action} />
        ) : (
          <InlineAlert tone={link.state === "used" ? "success" : "warning"}>
            {tr(`gateway.auth.actionLink.signedOut.state.${link.state}`)}
          </InlineAlert>
        )}
        <NextLink
          href={`/auth/sign-in?next=${encodeURIComponent(next)}` as Route}
          className="text-text-14 text-accent-text underline"
        >
          {t("signedOut.signInInstead")}
        </NextLink>
      </div>
    );
  }
  const result = await readActionLink(ctx.db, token, "Gateway");
  const link = result.ok ? result.data : null;
  const icon = (
    <span className="text-text-tertiary">
      <Icon name="MailCheck" size={28} />
    </span>
  );

  if (!link || link.state !== "ready" || link.action === null) {
    const state = link && link.state !== "ready" ? link.state : "invalid";
    return (
      <div className="flex flex-col gap-16">
        {icon}
        <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
        <InlineAlert tone={state === "used" ? "success" : "warning"}>
          {tr(`gateway.auth.actionLink.state.${state}`)}
        </InlineAlert>
        <NextLink href={"/home" as Route} className="text-text-14 text-accent-text underline">
          {t("home")}
        </NextLink>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      {icon}
      <h1 className="m-0 text-heading-20 font-semibold">
        {tr(`gateway.auth.actionLink.heading.${link.action}`, {
          title: link.title ?? t("untitled"),
        })}
      </h1>
      {link.orgName ? (
        <p className="m-0 text-text-14 text-text-secondary">{t("org", { org: link.orgName })}</p>
      ) : null}
      {ctx.email ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("signedInAs", { email: ctx.email })}
        </p>
      ) : null}
      <ActionLinkForm token={token} action={link.action} />
    </div>
  );
}
