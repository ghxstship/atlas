import { listForYourInformation } from "@xos/data/notification-actions";
import type { XosClient } from "@xos/data";
import { FyiList, type FyiRow } from "@/components/home/fyi-list";
import { RegionError, Section } from "@/components/page/page";
import { formatDateTime } from "@/lib/format";
import { fyiSentence } from "@/lib/fyi-sentence";
import type { Translate } from "@/lib/shell/translate";

/** A Gateway path an emitter names (gatewayPath): absolute, on Gateway's own origin, with an optional section. */
const GATEWAY_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]{0,199}(#[A-Za-z0-9._~-]{1,64})?$/;

/**
 * Gateway Home's For Your Information list (A127; Section 11.10 rule 5, one inbox model), beside Needs You: the
 * person's notifications from every org that need nothing from them (app.inbox_items, less the shifts and offers
 * still waiting on their answer), such as the steps of their invoices (finding A38-002), saved-search matches and
 * expiry reminders. Done (E) and Snooze (H) clear each one; the same notifications go out by email and push as the
 * person chose in Settings, Notifications. When a company entered project details for the person (R5), the item
 * opens those details in place, so the person checks and corrects them.
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
    const text = fyiSentence(t, n);
    const path = n.args["gatewayPath"];
    return {
      id: n.id,
      text,
      href: path && GATEWAY_PATH.test(path) ? path : null,
      when: formatDateTime(locale, n.createdAt),
      unread: !n.read,
      doneLabel: t("gateway.home.fyi.doneLabel", { text }),
      snoozeLabel: t("gateway.home.fyi.snoozeLabel", { text }),
      projectFacts:
        n.kind === "roster_entry.project_facts_entered" &&
        n.subjectTable === "engagement_roster_entries" &&
        n.subjectId
          ? {
              rosterEntryId: n.subjectId,
              name: n.args["personName"] ?? "",
              companyName: n.args["companyName"] ?? "",
              projectName: n.args["projectName"] ?? "",
            }
          : null,
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
