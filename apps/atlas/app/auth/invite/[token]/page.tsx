import { previewInvite } from "@xos/data";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AcceptInviteForm, errorMessage } from "@/components/auth/forms";
import { ButtonLink, InlineAlert } from "@/components/ui";
import { getViewer } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.invite");
  return { title: t("accept") };
}

/**
 * Invitation acceptance (Section 4.8.1, ways to join). The preview and the acceptance go through
 * app.preview_invite and app.accept_invite, which only answer the confirmed sign-in the invite
 * was sent to; a person who is signed out signs in or signs up first and comes back here.
 */
export default async function InvitePage({ params }: PageProps<"/auth/invite/[token]">) {
  const { token } = await params;
  const here = `/auth/invite/${encodeURIComponent(token)}`;
  const viewer = await getViewer();
  if (!viewer) redirect(`/auth/sign-up?next=${encodeURIComponent(here)}`);
  const [t, translate, format] = await Promise.all([
    getTranslations("shell.auth.invite"),
    getTranslate(),
    getFormatter(),
  ]);
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
      <AcceptInviteForm token={token} />
    </div>
  );
}
