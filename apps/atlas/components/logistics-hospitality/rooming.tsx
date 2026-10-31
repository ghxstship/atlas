"use client";

import type { RoomingEntry, RoomingStatus } from "@xos/data/lodging";
import { Button, Input, Select } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useMemo, useState, useTransition } from "react";
import { assignRoomAction } from "@/app/[org]/hospitality/actions";
import type { AllocationRowProps } from "@/components/advancing/allocation-dialogs";
import { blocksFor, filterRooming, ROOMING_FILTERS, stayToAssign } from "@/lib/hospitality/rooming";
import { issueRowAction, roomingListAction, type RoomingRead } from "./rooming-actions";

/** R7's Issue dialog loads when Assign room opens it for an Approved allocation. */
const IssueAllocationDialog = dynamic(() =>
  import("@/components/advancing/allocation-dialogs").then((m) => m.IssueAllocationDialog),
);

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The rooming list of a project (B5, G-67), read on request because each read is logged per person (R5): who needs a
 * room, the stays suggested from passes or travel dates, the rooms they hold, what is uncovered and the cost. Assign
 * room opens R7's Issue dialog when the person has an Approved block allocation not yet issued; otherwise the room
 * assignment form, prefilled with the suggested stay and saved only when confirmed. No export (R5).
 */
export function RoomingList({ org, projectId }: { org: string; projectId: string }) {
  const t = useTranslations("hospitality.rooming") as unknown as Translate;
  const format = useFormatter();
  const [read, setRead] = useState<RoomingRead | null | "failed">(null);
  const [pending, start] = useTransition();
  const [statuses, setStatuses] = useState<ReadonlySet<RoomingStatus>>(new Set());
  const [assigning, setAssigning] = useState<string | null>(null);
  const [issue, setIssue] = useState<{ row: AllocationRowProps; entry: RoomingEntry } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = () =>
    start(async () => setRead((await roomingListAction(org, projectId)) ?? "failed"));
  const shown = useMemo(
    () => (read && read !== "failed" ? filterRooming(read.entries, statuses) : []),
    [read, statuses],
  );
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const stay = (s: { checkInOn: string; checkOutOn: string }) =>
    t("stay", { from: date(s.checkInOn), to: date(s.checkOutOn) });

  if (read === null || read === "failed") {
    return (
      <div className="flex flex-col gap-8">
        <p className="m-0 text-text-13 text-text-secondary">{t("sentence")}</p>
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            aria-busy={pending}
            onClick={load}
          >
            {t("load")}
          </Button>
        </div>
        {read === "failed" ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("failed")}</p>
        ) : null}
      </div>
    );
  }

  const toggle = (s: RoomingStatus) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const openAssign = (entry: RoomingEntry) => {
    setMessage(null);
    if (entry.lodgingAllocationId) {
      const id = entry.lodgingAllocationId;
      start(async () => {
        const row = await issueRowAction(org, id, {
          item: t("room"),
          holder: entry.personName ?? t("unnamed"),
        });
        if (row) setIssue({ row, entry });
        else setMessage(t("issueFailed"));
      });
    } else {
      setAssigning(entry.rosterEntryId);
    }
  };

  return (
    <div className="flex flex-col gap-12">
      <div
        role="group"
        aria-label={t("filters.label")}
        className="flex flex-wrap items-center gap-8"
      >
        {ROOMING_FILTERS.map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={statuses.has(s) ? "primary" : "ghost"}
            aria-pressed={statuses.has(s)}
            onClick={() => toggle(s)}
          >
            {t(`status.${s.replace(" ", "")}`)}
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={load}>
          {t("reload")}
        </Button>
      </div>
      {message ? (
        <p className="m-0 text-text-13 text-text-secondary" role="status">
          {message}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {read.entries.length === 0 ? t("empty") : t("emptyFiltered")}
        </p>
      ) : (
        <div
          role="region"
          aria-label={t("title")}
          tabIndex={0}
          className="overflow-x-auto rounded-card border border-border-subtle"
        >
          <table className="w-full border-collapse text-text-13">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr>
                {[
                  "person",
                  "party",
                  "role",
                  "suggested",
                  "assigned",
                  "uncovered",
                  "status",
                  "cost",
                  "actions",
                ].map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className="px-12 py-6 text-start text-text-12 font-medium text-text-secondary bg-bg-surface"
                  >
                    {t(`columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const proposed = stayToAssign(e);
                return (
                  <tr key={e.rosterEntryId} className="border-t border-border-subtle align-top">
                    <th scope="row" className="px-12 py-6 text-start font-normal">
                      {e.personName ?? t("unnamed")}
                    </th>
                    <td className="px-12 py-6">{e.partyName ?? ""}</td>
                    <td className="px-12 py-6 font-mono text-text-12">{e.roleCode ?? ""}</td>
                    <td className="px-12 py-6">
                      {e.suggestedStays.length === 0
                        ? t("noDates")
                        : e.suggestedStays.map((s) => (
                            <div key={s.checkInOn}>
                              {t("stayWithSource", {
                                stay: stay(s),
                                source: t(`source.${s.source}`),
                              })}
                            </div>
                          ))}
                    </td>
                    <td className="px-12 py-6">
                      {e.assignedStays.length === 0
                        ? t("none")
                        : e.assignedStays.map((s) => (
                            <div key={s.assignmentId}>
                              {stay(s)}{" "}
                              <span className="text-text-12 text-text-secondary">
                                {s.blockTitle ?? ""}
                              </span>
                            </div>
                          ))}
                    </td>
                    <td className="px-12 py-6 tabular-nums">{e.uncoveredNights}</td>
                    <td className="px-12 py-6">{t(`status.${e.status.replace(" ", "")}`)}</td>
                    <td className="px-12 py-6">
                      {e.cost.length === 0
                        ? t("none")
                        : e.cost.map((c) => (
                            <div key={c.currencyCode ?? "unpriced"}>
                              {c.amountMinor === null || c.currencyCode === null
                                ? t("unpriced", { nights: c.nights })
                                : format.number(
                                    c.amountMinor / 10 ** (read.exponents[c.currencyCode] ?? 2),
                                    {
                                      style: "currency",
                                      currency: c.currencyCode,
                                    },
                                  )}
                            </div>
                          ))}
                    </td>
                    <td className="px-12 py-6">
                      {e.status === "Covered" ? null : assigning === e.rosterEntryId ? (
                        <AssignForm
                          org={org}
                          entry={e}
                          blocks={blocksFor(read.blocks, proposed)}
                          t={t}
                          onDone={(ok) => {
                            setAssigning(null);
                            setMessage(ok ? t("assigned") : null);
                            if (ok) load();
                          }}
                        />
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending}
                          onClick={() => openAssign(e)}
                        >
                          {t("assign")}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {issue ? (
        <IssueAllocationDialog
          org={org}
          row={issue.row}
          open
          onOpenChange={(open) => {
            if (!open) {
              setIssue(null);
              load();
            }
          }}
          {...(stayToAssign(issue.entry)
            ? {
                prefill: {
                  checkIn: stayToAssign(issue.entry)?.checkInOn ?? "",
                  checkOut: stayToAssign(issue.entry)?.checkOutOn ?? "",
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}

/** The room assignment form, prefilled with the suggested stay; nothing is saved until Confirm. */
function AssignForm({
  org,
  entry,
  blocks,
  t,
  onDone,
}: {
  org: string;
  entry: RoomingEntry;
  blocks: RoomingRead["blocks"];
  t: Translate;
  onDone: (ok: boolean) => void;
}) {
  const te = useTranslations("logistics.common.errors") as unknown as Translate;
  const proposed = stayToAssign(entry);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (blocks.length === 0)
    return <p className="m-0 text-text-12 text-text-secondary">{t("noBlocks")}</p>;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
          const state = await assignRoomAction({}, form);
          if (state.ok) onDone(true);
          else setError(state.error ? te(state.error) : t("checkFields"));
        });
      }}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="personId" value={entry.personId} />
      <Select
        name="blockId"
        label={t("block")}
        options={blocks.map((b) => ({ value: b.id, label: `${b.key} ${b.title}` }))}
      />
      <Input
        name="checkInOn"
        type="date"
        label={t("checkIn")}
        defaultValue={proposed?.checkInOn ?? ""}
        required
      />
      <Input
        name="checkOutOn"
        type="date"
        label={t("checkOut")}
        defaultValue={proposed?.checkOutOn ?? ""}
        required
      />
      {error ? (
        <p className="m-0 text-text-12 text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-4">
        <Button type="submit" size="sm" variant="primary" disabled={pending} aria-busy={pending}>
          {t("confirm")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone(false)}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
