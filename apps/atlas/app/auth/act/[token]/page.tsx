import { isActionToken, readActionLink } from "@xos/data/notification-actions";
import { MailCheck } from "lucide-react";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionLinkForm } from "@/components/auth/action-link-form";
import { InlineAlert } from "@/components/ui";
import { getViewer } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authSecurity.actionLink");
  return { title: t("pageTitle"), robots: { index: false, follow: false } };
}

/**
 * The confirm page of a one-tap email link (A127, ADR 0089; Section 11.10 rule 5): the email's Approve, Reject or
 * Accept button opens it, and one more press acts, so acting from an email takes two taps. Opening it only reads what
 * the link does (app.read_notification_action); someone else's link says nothing about itself. Signed out, the person
 * signs in and comes back here.
 */
export default async function ActionLinkPage({ params }: PageProps<"/auth/act/[token]">) {
  const { token } = await params;
  const viewer = await getViewer();
  if (!viewer) {
    const next = isActionToken(token) ? `/auth/act/${token}` : "/";
    redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  }
  const t = await getTranslations("authSecurity.actionLink");
  const tr = await getTranslate();
  const result = await readActionLink(viewer.db, token);
  const link = result.ok ? result.data : null;
  const inboxHref = link?.orgSlug ? `/${link.orgSlug}/inbox` : "/";

  const heading = (title: string) => (
    <div className="flex flex-col gap-8">
      <MailCheck aria-hidden="true" className="size-32 text-text-tertiary" />
      <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
    </div>
  );

  if (!link || link.state !== "ready" || link.action === null) {
    const state = link?.state ?? "invalid";
    return (
      <div className="flex flex-col gap-16">
        {heading(t("pageTitle"))}
        <InlineAlert tone={state === "used" ? "success" : "warning"}>
          {tr(`authSecurity.actionLink.state.${state === "ready" ? "invalid" : state}`)}
        </InlineAlert>
        <Link href={inboxHref as Route} className="text-text-14 text-accent-text underline">
          {t("openInbox")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      {heading(
        tr(`authSecurity.actionLink.heading.${link.action}`, {
          title: link.title ?? t("untitled"),
        }),
      )}
      {link.orgName ? (
        <p className="m-0 text-text-14 text-text-secondary">{t("org", { org: link.orgName })}</p>
      ) : null}
      {viewer.email ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("signedInAs", { email: viewer.email })}
        </p>
      ) : null}
      <ActionLinkForm token={token} action={link.action} inboxHref={inboxHref} />
    </div>
  );
}
