import { isActionToken, readActionLink } from "@xos/data/notification-actions";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { getTranslations } from "next-intl/server";
import { ActionLinkForm } from "@/components/tokens/action-link-form";
import { Icon, InlineAlert } from "@/components/ui";
import { requireContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.actionLink");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * The confirm page of a one-tap email link in Gateway (A127, ADR 0089; Section 11.10 rule 5): an engaged worker's
 * shift or an applicant's offer, accepted with one more press after the email's button. Opening it only reads what
 * the link does; someone else's link says nothing about itself. Signed out, the person signs in and comes back here.
 */
export default async function ActionLinkPage({ params }: PageProps<"/auth/act/[token]">) {
  const { token } = await params;
  const ctx = await requireContext(isActionToken(token) ? `/auth/act/${token}` : "/home");
  const [t, tr] = await Promise.all([getTranslations("gateway.auth.actionLink"), getTranslate()]);
  const result = await readActionLink(ctx.db, token);
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
