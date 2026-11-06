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
  // Offers, shifts and messages (A127, migration 5200).
  "offer.sent": "fyi.kinds.offerSent",
  "shift.assigned": "fyi.kinds.shiftAssigned",
  "shift.changed": "fyi.kinds.shiftChanged",
  "message.received": "fyi.kinds.messageReceived",
  // A company entered project details for the person (R5): they open their details here and correct them.
  "roster_entry.project_facts_entered": "updates.kinds.projectFactsEntered",
  // P5: an org asks for a badge photo (5822); the item opens Profile, Badge photos.
  "credential_photo.requested": "updates.kinds.badgePhotoRequested",
  // A crisis alert and its all-clear (6070): an alert names what to do, and the two never read the same.
  "crisis_alert.issued": "fyi.kinds.crisisAlert",
  "crisis_alert.ended": "fyi.kinds.crisisAllClear",
};

/** The sentence a For Your Information row reads, in the person's language: the kind's own, else its title. */
export function fyiSentence(
  t: Translate,
  n: { readonly kind: string; readonly args: Readonly<Record<string, string | undefined>> },
): string {
  const key = KINDS[n.kind];
  const values = {
    title: n.args["title"] ?? "",
    orgName: n.args["orgName"] ?? "",
    searchName: n.args["searchName"] ?? "",
    expiresOn: n.args["expiresOn"] ?? "",
    kind: n.args["kind"] ?? "other",
    actorName: n.args["actorName"] ?? "",
    projectName: n.args["projectName"] ?? "",
    project: n.args["project"] ?? "",
    message: n.args["message"] ?? "",
  };
  return key
    ? t(`gateway.home.${key}`, values)
    : values.title
      ? t("gateway.home.fyi.kinds.other", values)
      : t("gateway.home.fyi.kinds.untitled");
}
