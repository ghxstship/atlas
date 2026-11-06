import type { XosClient } from "@xos/data/client";
import { listMyIntakeRequests } from "@xos/data/vendor-intake";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import { Tag } from "@/components/ui";
import { submitIntakeInvoiceAction, withdrawIntakeAction } from "@/lib/actions/intake";
import { formatDate } from "@/lib/format";

import type { Translate } from "@/lib/shell/translate";

/**
 * Requests you sent (B2, ADR 0141): Gateway Home's card over api_external.my_vendor_intake_requests. Server-rendered,
 * since /home is a key page: nothing new loads in the browser beyond the shared ActionButton. Only the view's
 * allowlisted columns are read; the card stays away until there is a request.
 */
export async function IntakeRequestsCard({
  db,
  t,
  locale,
}: {
  db: XosClient;
  t: Translate;
  locale: string;
}) {
  const requests = await listMyIntakeRequests(db);
  if (!requests.ok) {
    return (
      <Section title={t("gateway.home.intake.title")}>
        <RegionError />
      </Section>
    );
  }
  if (requests.data.length === 0) return null;
  return (
    <Section title={t("gateway.home.intake.title")}>
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
        {requests.data.map((r) => (
          <li key={r.id} className="flex flex-col gap-4 p-12" data-intake-request-row={r.state}>
            <span className="flex flex-wrap items-baseline justify-between gap-8">
              <span className="text-text-14 text-text-primary">{r.title}</span>
              <Tag>{t(`gateway.home.intake.states.${r.state}`)}</Tag>
            </span>
            <span className="text-text-12 text-text-secondary">
              {r.orgName} · {r.projectName} ·{" "}
              {t("gateway.home.intake.sentOn", { date: formatDate(locale, r.createdAt) })}
            </span>
            {r.decisionReason ? (
              <span className="text-text-13 text-text-secondary">{r.decisionReason}</span>
            ) : null}
            {r.state === "Pending" ? (
              <span>
                <ActionButton
                  action={withdrawIntakeAction.bind(null, r.id)}
                  label={t("gateway.home.intake.withdraw")}
                  variant="ghost"
                />
              </span>
            ) : null}
            {r.invoiceReady ? (
              <span>
                <ActionButton
                  action={submitIntakeInvoiceAction.bind(null, r.id)}
                  label={t("gateway.home.intake.submitInvoice")}
                  variant="secondary"
                />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
