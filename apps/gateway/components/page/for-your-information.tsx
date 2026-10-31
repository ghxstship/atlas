import { listForYourInformation } from "@xos/data/notification-actions";
import type { XosClient } from "@xos/data";
import { FyiList, type FyiRow } from "@/components/home/fyi-list";
import { RegionError, Section } from "@/components/page/page";
import { RosterFactsButton } from "@/components/roster/roster-facts-button";
import { formatDateTime } from "@/lib/format";
import type { Translate } from "@/lib/shell/translate";

/** Notification kinds with their own sentence, with their catalog key under gateway.home. */
const KINDS: Readonly<Record<string, string>> = {
  "invoice.submitted": "updates.kinds.invoiceSubmitted",
  "invoice.approved": "updates.kinds.invoiceApproved",
  "invoice.scheduled": "updates.kinds.invoiceScheduled",
  "invoice.paid": "updates.kinds.invoicePaid",
  // Saved-search matches and expiry reminders (A89, migrations 1462 and 1463).
  "opportunity.matched": "updates.kinds.opportunityMatched",
  "onboarding.item_expiring": "updates.kinds.onboardingExpiring",
  "certification.expiring": "updates.kinds.certificationExpiring",
  "document.expiring": "updates.kinds.documentExpiring",
  // Offers, shifts and messages (A127, migration 2200).
  "offer.sent": "fyi.kinds.offerSent",
  "shift.assigned": "fyi.kinds.shiftAssigned",
  "shift.changed": "fyi.kinds.shiftChanged",
  "message.received": "fyi.kinds.messageReceived",
  // A company entered project details for the person (R5): they open their details here and correct them.
  "roster_entry.project_facts_entered": "updates.kinds.projectFactsEntered",
  // P8 (2853): an org asks for the person's availability; it links to /profile#availability-requests.
  "availability.requested": "updates.kinds.availabilityRequested",
};

/** A Gateway path an emitter names (gatewayPath): absolute, on Gateway's own origin. */
const GATEWAY_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]{0,199}$/;

/**
 * Gateway Home's For Your Information list (A127; Section 11.10 rule 5, one inbox model), beside Needs You: the
 * person's notifications from every org that need nothing from them (app.inbox_items, less the shifts and offers
 * still waiting on their answer), such as the steps of their invoices (finding A38-002), saved-search matches and
 * expiry reminders. When a company entered project details for the person (R5), the item opens those details in
 * place, so the person checks and corrects them. Done (E) and Snooze (H) clear each one; the same notifications go out by email and push as the
 * person chose in Settings, Notifications.
 */
export async function ForYourInformation({
  db,
  t,
  locale,
}: {
  db: XosClient;
  t: Translate;
  locale: string;
}) {
  const result = await listForYourInformation(db, 20);
  if (!result.ok)
    return (
      <Section title={t("gateway.home.fyi.title")}>
        <RegionError />
      </Section>
    );
  const rows: FyiRow[] = result.data.map((n) => {
    const key = KINDS[n.kind];
    const values = {
      title: n.args["title"] ?? "",
      orgName: n.args["orgName"] ?? "",
      searchName: n.args["searchName"] ?? "",
      expiresOn: n.args["expiresOn"] ?? "",
      kind: n.args["kind"] ?? "other",
      actorName: n.args["actorName"] ?? "",
      projectName: n.args["projectName"] ?? "",
    };
    const text = key
      ? t(`gateway.home.${key}`, values)
      : values.title
        ? t("gateway.home.fyi.kinds.other", values)
        : t("gateway.home.fyi.kinds.untitled");
    const path = n.args["gatewayPath"];
    const rosterEntryId =
      n.kind === "roster_entry.project_facts_entered" && n.subject?.table === "engagement_roster_entries"
        ? n.subject.id
        : null;
    return {
      id: n.id,
      text,
      href: path && GATEWAY_PATH.test(path) ? path : null,
      when: formatDateTime(locale, n.createdAt),
      unread: !n.read,
      extra: rosterEntryId ? (
        <RosterFactsButton
          rosterEntryId={rosterEntryId}
          name={n.args["personName"] ?? ""}
          companyName={n.args["companyName"] ?? ""}
          projectName={n.args["projectName"] ?? ""}
          self
        />
      ) : undefined,
      doneLabel: t("gateway.home.fyi.doneLabel", { text }),
      snoozeLabel: t("gateway.home.fyi.snoozeLabel", { text }),
    };
  });
  return (
    <Section title={t("gateway.home.fyi.title")}>
      {rows.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">{t("gateway.home.fyi.empty")}</p>
      ) : (
        <FyiList
          rows={rows}
          labels={{
            title: t("gateway.home.fyi.title"),
            done: t("gateway.home.fyi.done"),
            snooze: t("gateway.home.fyi.snooze"),
            keys: t("gateway.home.fyi.keys"),
            new: t("gateway.home.fyi.new"),
            empty: t("gateway.home.fyi.empty"),
          }}
        />
      )}
    </Section>
  );
}
