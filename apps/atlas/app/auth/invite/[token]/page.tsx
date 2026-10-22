import { inviteTokenOpen, previewInvite } from "@xos/data";
import { minimumAgeConfirmed } from "@xos/data/consent";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AcceptInviteForm, errorMessage } from "@/components/auth/forms";
import { ButtonLink, InlineAlert } from "@/components/ui";
import { getViewer } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.invite");
  return { title: t("accept") };
}

/**
 * Invitation acceptance (Section 4.8.1, ways to join). Email invitations preview and accept through
 * app.preview_invite and app.accept_invite, which only answer the confirmed sign-in the invite was
 * sent to. Invitation links (xlnk_ tokens) accept through app.accept_invite_link for any signed-in
 * person. A person who is signed out signs in or signs up first and comes back here.
 */
export default async function InvitePage({ params }: PageProps<"/auth/invite/[token]">) {
  const { token } = await params;
  const here = `/auth/invite/${encodeURIComponent(token)}`;
  const viewer = await getViewer();
  if (!viewer) {
    // A dead link says so before anyone creates an account for it (A59-024).
    const open = await inviteTokenOpen(await createServerSupabase(), token);
    if (!open.ok || open.data) redirect(`/auth/sign-up?next=${encodeURIComponent(here)}`);
    const t = await getTranslations("shell.auth.invite");
    return (
      <div className="flex flex-col gap-16">
        <h1 className="text-heading-20 font-semibold">{t("closedTitle")}</h1>
        <p className="text-text-14 text-text-secondary">{t("closedBody")}</p>
        <div className="flex flex-wrap gap-8">
          <ButtonLink href="/auth/sign-in" variant="primary">
            {t("signIn")}
          </ButtonLink>
          <ButtonLink href="/">{t("home")}</ButtonLink>
        </div>
      </div>
    );
  }
  const [t, translate, format, age] = await Promise.all([
    getTranslations("shell.auth.invite"),
    getTranslate(),
    getFormatter(),
    minimumAgeConfirmed(viewer.db),
  ]);
  const askAge = !(age.ok && age.data);
  if (token.startsWith("xlnk_")) {
    return (
      <div className="flex flex-col gap-16">
        <h1 className="text-heading-20 font-semibold">{t("accept")}</h1>
        <p className="text-text-14 text-text-secondary">{translate("profiles.join.linkBody")}</p>
        <AcceptInviteForm token={token} askAge={askAge} />
      </div>
    );
  }
  const preview = await previewInvite(viewer.db, token);
  if (!preview.ok) {
    const key =
      preview.error.kind === "refusal" ? `invite.${preview.error.rule}` : "invite.invite_invalid";
    return (
      <div className="flex flex-col gap-16">
        <h1 className="text-heading-20 font-semibold">{t("accept")}</h1>
        <InlineAlert tone="danger">
          {errorMessage((k) => translate(`shell.auth.${k}`), key)}
        </InlineAlert>
        <p className="text-text-13 text-text-secondary">{t("signInFirst")}</p>
        <ButtonLink href="/">{t("home")}</ButtonLink>
      </div>
    );
  }
  const { orgName, roleCode, roleName, expiresAt } = preview.data;
  const role = roleName ?? translate(`shell.roles.${roleCode}`);
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("title", { org: orgName })}</h1>
      <p className="text-text-14 text-text-secondary">
        {t("body", {
          org: orgName,
          role,
          expires: format.relativeTime(new Date(expiresAt)),
        })}
      </p>
      <AcceptInviteForm token={token} askAge={askAge} />
    </div>
  );
}
