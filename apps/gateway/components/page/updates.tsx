import { listMyNotifications } from "@xos/data/party-notifications";
import type { XosClient } from "@xos/data";
import type { Route } from "next";
import Link from "next/link";
import { RegionError, Section } from "@/components/page/page";
import { RosterFactsButton } from "@/components/roster/roster-facts-button";
import { formatDateTime } from "@/lib/format";
import type { Translate } from "@/lib/shell/translate";

/** Notification kinds Gateway has copy for, with their catalog key. */
const KINDS: Readonly<Record<string, string>> = {
  "invoice.submitted": "invoiceSubmitted",
  "invoice.approved": "invoiceApproved",
  "invoice.scheduled": "invoiceScheduled",
  "invoice.paid": "invoicePaid",
  // Saved-search matches and expiry reminders (A89, migrations 1462 and 1463).
  "opportunity.matched": "opportunityMatched",
  "onboarding.item_expiring": "onboardingExpiring",
  "certification.expiring": "certificationExpiring",
  "document.expiring": "documentExpiring",
  // A company entered project details for the person (R5): they open their details here and correct them.
  "roster_entry.project_facts_entered": "projectFactsEntered",
  // P5: an org asks for a badge photo (2822); the item opens Profile, Badge photos.
  "credential_photo.requested": "badgePhotoRequested",
};

/**
 * The person's latest updates in Gateway (finding A38-002): in-app notifications for the steps of
 * their invoices, each linking to where they follow it. The same notifications go out by Email and
 * Push as the person chose in Settings, Notifications. When a company entered project details for
 * the person (R5), the update opens those details in place, so the person checks and corrects them.
 */
export async function Updates({ db, t, locale }: { db: XosClient; t: Translate; locale: string }) {
  const result = await listMyNotifications(db, 10);
  if (!result.ok) return <RegionError />;
  const items = result.data.filter((n) => KINDS[n.kind] !== undefined).slice(0, 5);
  if (items.length === 0) return null;
  return (
    <Section title={t("gateway.home.updates.title")}>
      <ul
        className="m-0 flex list-none flex-col gap-8 p-0"
        aria-label={t("gateway.home.updates.title")}
      >
        {items.map((n) => {
          const text = t(`gateway.home.updates.kinds.${KINDS[n.kind] ?? ""}`, {
            title: n.args["title"] ?? "",
            orgName: n.args["orgName"] ?? "",
            searchName: n.args["searchName"] ?? "",
            expiresOn: n.args["expiresOn"] ?? "",
            kind: n.args["kind"] ?? "other",
            actorName: n.args["actorName"] ?? "",
            projectName: n.args["projectName"] ?? "",
          });
          const path = n.args["gatewayPath"];
          const rosterEntryId =
            n.kind === "roster_entry.project_facts_entered" &&
            n.subject?.table === "engagement_roster_entries"
              ? n.subject.id
              : null;
          return (
            <li
              key={n.id}
              className="flex flex-col gap-2 rounded-card border border-border-subtle bg-bg-raised p-12"
            >
              {path && path.startsWith("/") ? (
                <Link href={path as Route} className="text-text-14 font-medium text-text-primary">
                  {text}
                </Link>
              ) : (
                <span className="text-text-14 font-medium">{text}</span>
              )}
              <span className="text-text-12 text-text-secondary">
                {formatDateTime(locale, n.createdAt)}
                {n.read ? "" : ` · ${t("gateway.home.updates.new")}`}
              </span>
              {rosterEntryId ? (
                <span>
                  <RosterFactsButton
                    rosterEntryId={rosterEntryId}
                    name={n.args["personName"] ?? ""}
                    companyName={n.args["companyName"] ?? ""}
                    projectName={n.args["projectName"] ?? ""}
                    self
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
