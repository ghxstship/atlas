import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { myPendingInvitations } from "@xos/data/roster";
import { ActionButton } from "@/components/actions/action-button";
import { ClaimForm } from "@/components/tokens/claim-form";
import { Icon } from "@/components/ui";
import { respondPartyInvitationAction } from "@/lib/actions/roster";
import { requireContext } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.auth.claim");
  return { title: t("title") };
}

/**
 * Account claim after a token flow (Section 4.4.6, journey 50): advance answers and signatures
 * given through a link sent to the person's verified email join this account
 * (app.claim_token_submissions), so they show under Work and Documents. Account and roster
 * invitations sent to the same address are listed too, to accept or decline here (R4).
 */
export default async function ClaimPage() {
  const ctx = await requireContext("/auth/claim");
  const t = await getTranslations("gateway.auth.claim");
  const invitations = await myPendingInvitations(ctx.db);
  const pending = invitations.ok ? invitations.data : [];
  return (
    <div className="flex flex-col gap-16">
      <span className="text-text-tertiary">
        <Icon name="Link2" size={28} />
      </span>
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">
        {t("body", { email: ctx.email ?? "" })}
      </p>
      <ClaimForm email={ctx.email ?? ""} />
      {pending.length > 0 ? (
        <section aria-label={t("invitations")} className="flex flex-col gap-8">
          <h2 className="m-0 text-heading-16 font-semibold">{t("invitations")}</h2>
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {pending.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-12">
                <span className="min-w-0 flex-1 text-text-14">
                  {i.kind === "account"
                    ? t("invitationAccount", { account: i.accountName ?? "" })
                    : t("invitationRoster", {
                        party: i.partyName ?? "",
                        project: i.projectName ?? "",
                      })}
                </span>
                <ActionButton
                  action={respondPartyInvitationAction.bind(null, i.kind, i.id, true)}
                  label={t("accept")}
                  variant="secondary"
                />
                <ActionButton
                  action={respondPartyInvitationAction.bind(null, i.kind, i.id, false)}
                  label={t("decline")}
                  variant="ghost"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
