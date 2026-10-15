import { listStateHistory, type StateLedger } from "@xos/data/commercial-common";
import { listMembers } from "@xos/data";
import { getFormatter } from "next-intl/server";
import { getCopy } from "@/lib/collection-kit/i18n";
import type { OrgContext } from "@/lib/shell/context";
import { ErrorPanel, KitSection } from "./kit";

/** The state history of one row from its append-only lifecycle ledger, oldest first. */
export async function StateHistory({
  ctx,
  ledger,
  id,
  stateLabel,
}: {
  ctx: OrgContext;
  ledger: StateLedger;
  id: string;
  stateLabel: (state: string) => string;
}) {
  const [history, members, t, format] = await Promise.all([
    listStateHistory(ctx.viewer.db, ledger, id),
    listMembers(ctx.viewer.db, ctx.org.id),
    getCopy("procurement.kit.history"),
    getFormatter(),
  ]);
  if (!history.ok) return <ErrorPanel what={t("what")} />;
  const names = new Map((members.ok ? members.data : []).map((m) => [m.personId, m.fullName]));
  return (
    <KitSection id={`history-${id}`} title={t("title")}>
      <ol className="m-0 flex list-none flex-col gap-8 p-0">
        {history.data.map((h) => (
          <li key={h.id} className="flex flex-col gap-2 border-s-2 border-border-subtle ps-12">
            <span className="text-text-13 font-medium">
              {h.from === null
                ? t("created", { state: stateLabel(h.to) })
                : t("moved", { from: stateLabel(h.from), to: stateLabel(h.to) })}
            </span>
            <span className="text-text-12 text-text-secondary">
              {format.dateTime(new Date(h.at), { dateStyle: "medium", timeStyle: "short" })}
              {h.by ? ` · ${names.get(h.by) ?? t("someone")}` : ""}
            </span>
            {h.from !== null ? <span className="text-text-13">{h.reason}</span> : null}
          </li>
        ))}
      </ol>
    </KitSection>
  );
}
