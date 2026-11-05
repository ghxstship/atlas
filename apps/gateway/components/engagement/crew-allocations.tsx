import {
  namesClosed,
  poolAllocations,
  requestableValue,
  shareOf,
  type EngagedAllocation,
  type RequestableItem,
} from "@xos/data/gateway-allocations";
import type { RosterEntry } from "@xos/data/roster";
import { ActionButton } from "@/components/actions/action-button";
import { Section } from "@/components/page/page";
import { returnShareAction, withdrawAllocationAction } from "@/lib/actions/allocations";
import { enumKey } from "@/lib/enum-key";
import { formatDateTime } from "@/lib/format";
import { allocationTone } from "@/lib/roster-member";
import type { Translate } from "@/lib/shell/translate";
import { AssignFromPool, RequestItemForm } from "./allocation-forms";
import { RowList } from "./rows";

/**
 * What the party asks for and shares out on its Crew tab (R8, ADR 0103 and 0104): the pool it holds
 * with what is left of each item, the items of each person on its roster with their computed status,
 * a Request item form and Assign from pool for several people at once. Status is computed by the
 * database (owner decision 8): Gateway shows it and never confirms possession, which only Issue does.
 * A credential pool requested through an advance answer stops taking names at its recipient's
 * naming deadline (G-141, R9): Assign from pool leaves it out and its shares lose Give back.
 */

/** The sentence a closed credential pool shows: who to ask now that the party cannot rename it. */
export function namesClosedSentence(
  a: { readonly namesDueAt: string | null },
  orgName: string,
  t: Translate,
  locale: string,
): string {
  return t("gateway.engagement.advance.namesDue.closed", {
    date: formatDateTime(locale, a.namesDueAt ?? ""),
    org: orgName,
  });
}

/** An allocation's name in a list: its item, else its kind (Travel, Per Diem). */
export function allocationTitle(a: EngagedAllocation, t: Translate): string {
  return a.itemName ?? t(`gateway.engagement.crew.items.kind.${enumKey(a.kind)}`);
}

/** The status tag of an allocation, from its computed display status. */
export function allocationTag(a: EngagedAllocation, t: Translate) {
  return {
    label: t(`gateway.engagement.crew.items.status.${enumKey(a.status)}`),
    tone: allocationTone(a.status),
  };
}

/** The items one person on the roster holds or asked for, for their row of the Crew tab. */
export function EntryItems({
  allocations,
  rosterEntryId,
  t,
  locale,
}: {
  allocations: readonly EngagedAllocation[];
  rosterEntryId: string;
  t: Translate;
  locale: string;
}) {
  const items = allocations.filter(
    (a) => a.rosterEntryId === rosterEntryId && a.state !== "Withdrawn",
  );
  if (items.length === 0) return null;
  return (
    <RowList
      label={t("gateway.engagement.crew.items.title")}
      items={items.map((a) => ({
        id: a.id,
        title: t("gateway.engagement.crew.items.line", {
          n: a.quantity,
          item: allocationTitle(a, t),
        }),
        meta: [
          formatDateTime(locale, a.neededFrom, a.neededTimeZone),
          a.declineReason
            ? t("gateway.engagement.crew.items.declined", { reason: a.declineReason })
            : null,
        ],
        tag: allocationTag(a, t),
        ...(a.state === "Requested"
          ? {
              action: (
                <ActionButton
                  action={withdrawAllocationAction.bind(null, a.id)}
                  label={t("gateway.engagement.crew.items.withdraw")}
                  variant="ghost"
                  done={t("gateway.engagement.crew.items.withdrawn")}
                />
              ),
            }
          : a.parentAllocationId &&
              a.state === "Approved" &&
              a.issuedQuantity === 0 &&
              !namesClosed(a)
            ? {
                action: (
                  <ActionButton
                    action={returnShareAction.bind(null, a.id)}
                    label={t("gateway.engagement.crew.items.giveBack")}
                    variant="ghost"
                    done={t("gateway.engagement.crew.items.givenBack")}
                  />
                ),
              }
            : {}),
      }))}
    />
  );
}

export function CrewAllocations({
  engagementId,
  timeZone,
  orgName,
  entries,
  allocations,
  requestable,
  t,
  locale,
}: {
  engagementId: string;
  timeZone: string;
  orgName: string;
  entries: readonly RosterEntry[];
  allocations: readonly EngagedAllocation[];
  requestable: readonly RequestableItem[];
  t: Translate;
  locale: string;
}) {
  const now = new Date();
  const pools = poolAllocations(allocations);
  const requestedPool = allocations.filter(
    (a) => a.rosterEntryId === null && a.state === "Requested",
  );
  const shown = [...pools, ...requestedPool];
  const people = entries.filter((e) => e.personId !== null && e.entryState !== "Withdrawn");
  const itemLabel = (i: RequestableItem) =>
    i.itemKind === "service"
      ? t(`gateway.engagement.crew.items.kind.${enumKey(i.name)}`)
      : i.capPerPerson !== null
        ? t("gateway.engagement.crew.request.itemCapped", { name: i.name, n: i.capPerPerson })
        : i.name;
  return (
    <>
      <Section id="crew-pool" title={t("gateway.engagement.crew.pool.title")}>
        <p className="m-0 max-w-[60ch] text-text-14 text-text-secondary">
          {t("gateway.engagement.crew.pool.sentence")}
        </p>
        {shown.length === 0 ? (
          <p className="m-0 text-text-14 text-text-secondary">
            {t("gateway.engagement.crew.pool.empty")}
          </p>
        ) : (
          <RowList
            label={t("gateway.engagement.crew.pool.title")}
            items={shown.map((a) => ({
              id: a.id,
              title: allocationTitle(a, t),
              meta: [
                a.state === "Approved"
                  ? t("gateway.engagement.crew.pool.left", { n: a.quantity })
                  : t("gateway.engagement.crew.pool.asked", { n: a.quantity }),
                formatDateTime(locale, a.neededFrom, a.neededTimeZone),
                a.namesDueAt === null
                  ? null
                  : namesClosed(a, now)
                    ? namesClosedSentence(a, orgName, t, locale)
                    : t("gateway.engagement.advance.namesDue.open", {
                        date: formatDateTime(locale, a.namesDueAt),
                      }),
              ],
              tag: allocationTag(a, t),
              ...(a.state === "Requested"
                ? {
                    action: (
                      <ActionButton
                        action={withdrawAllocationAction.bind(null, a.id)}
                        label={t("gateway.engagement.crew.items.withdraw")}
                        variant="ghost"
                        done={t("gateway.engagement.crew.items.withdrawn")}
                      />
                    ),
                  }
                : {}),
            }))}
          />
        )}
        {pools.length > 0 && people.length > 0 ? (
          <AssignFromPool
            pools={pools.map((p) => ({
              value: p.id,
              label: allocationTitle(p, t),
              left: p.quantity,
              // Past its naming deadline a credential pool keeps its names; only production changes them.
              closed: namesClosed(p, now) ? namesClosedSentence(p, orgName, t, locale) : null,
            }))}
            entries={people.map((e) => ({
              id: e.id,
              name: e.fullName ?? "",
              eligible: e.entryState === "Accepted" && e.personResponse === "Accepted",
              shares: Object.fromEntries(
                pools.map((p) => [p.id, shareOf(allocations, p.id, e.id)]),
              ),
            }))}
          />
        ) : null}
      </Section>
      <Section id="crew-request" title={t("gateway.engagement.crew.request.title")}>
        {requestable.length === 0 ? (
          <p className="m-0 text-text-14 text-text-secondary">
            {t("gateway.engagement.crew.request.nothing")}
          </p>
        ) : (
          <RequestItemForm
            engagementId={engagementId}
            timeZone={timeZone}
            holders={[
              { value: "pool", label: t("gateway.engagement.crew.request.forPool") },
              ...people
                .filter((e) => e.entryState !== "Returned" && e.personResponse !== "Declined")
                .map((e) => ({ value: e.id, label: e.fullName ?? "" })),
            ]}
            items={requestable.map((i) => ({ value: requestableValue(i), label: itemLabel(i) }))}
          />
        )}
      </Section>
    </>
  );
}
