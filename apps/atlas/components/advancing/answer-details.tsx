import type { AnswerFile, AnswerLine } from "@xos/data/advancing";
import type { Route } from "next";
import Link from "next/link";
import type { Translate } from "@/lib/shell/translate";
import { BookDockSlotForm } from "./answer-forms";
import { Tag } from "./ui";

/**
 * What a typed advance answer holds, for its reviewer (R9, migrations 2711 and 2712): the note, the
 * lines with the item, quantity, person and window in the window's zone and each allocation's
 * computed stage (app.advance_allocation_status), "Named n of q" on a credential pool (G-141), the
 * files as links served by /files/party/<version>, and Book dock slot on an Accepted Load In or Load
 * Out window. After acceptance it counts the items that still need a decision in Allocations.
 */
export function AnswerDetails({
  org,
  note,
  accepted,
  bookable,
  lines,
  files,
  zones,
  t,
  when,
}: {
  org: string;
  note: string | null;
  accepted: boolean;
  /** The section is a Load In or Load Out window and the viewer may book dock slots. */
  bookable: boolean;
  lines: readonly AnswerLine[];
  files: readonly AnswerFile[];
  zones: readonly { value: string; label: string }[];
  t: Translate;
  when: (iso: string, timeZone: string | null) => string;
}) {
  const waiting = accepted ? lines.filter((l) => l.allocationStatus === "Requested").length : 0;
  if (note === null && lines.length === 0 && files.length === 0) return null;
  return (
    <div className="flex flex-col gap-8">
      {note ? <p className="m-0 text-text-13">{t("advancing.answers.note", { note })}</p> : null}
      {files.length > 0 ? (
        <ul
          aria-label={t("advancing.answers.files")}
          className="m-0 flex list-none flex-col gap-4 p-0"
        >
          {files.map((f) =>
            f.versionId ? (
              <li key={f.id}>
                <Link
                  href={`/files/party/${f.versionId}` as Route}
                  prefetch={false}
                  className="text-text-13 text-accent-text hover:underline"
                >
                  {f.title}
                </Link>
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      {lines.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-text-13">
            <caption className="sr-only">{t("advancing.answers.lines")}</caption>
            <thead className="text-text-12 text-text-secondary">
              <tr>
                <th scope="col" className="py-4 pr-8 font-medium">
                  {t("advancing.answers.columns.item")}
                </th>
                <th scope="col" className="py-4 pr-8 font-medium">
                  {t("advancing.answers.columns.quantity")}
                </th>
                <th scope="col" className="py-4 pr-8 font-medium">
                  {t("advancing.answers.columns.person")}
                </th>
                <th scope="col" className="py-4 pr-8 font-medium">
                  {t("advancing.answers.columns.window")}
                </th>
                <th scope="col" className="py-4 font-medium">
                  {t("advancing.answers.columns.stage")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-4 pr-8">{l.itemName ?? t("advancing.answers.window")}</td>
                  <td className="py-4 pr-8">
                    {l.quantity ?? ""}
                    {l.namedQuantity !== null && l.poolQuantity !== null ? (
                      <span className="block text-text-12 text-text-secondary">
                        {t("advancing.answers.named", { n: l.namedQuantity, q: l.poolQuantity })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-4 pr-8">
                    {l.personName ?? (l.rosterEntryId ? "" : t("advancing.answers.pool"))}
                  </td>
                  <td className="py-4 pr-8">
                    {l.neededFrom && l.neededTo
                      ? t("advancing.answers.windowRange", {
                          from: when(l.neededFrom, l.windowZone),
                          to: when(l.neededTo, l.windowZone),
                        })
                      : ""}
                  </td>
                  <td className="py-4">
                    {l.allocationStatus ? (
                      <Tag>
                        {t(
                          `advancing.allocations.statuses.${l.allocationStatus.toLowerCase().replaceAll(" ", "_")}`,
                        )}
                      </Tag>
                    ) : null}
                    {bookable && accepted && l.neededFrom ? (
                      l.dockSlotId ? (
                        <span className="text-text-12 text-success-text">
                          {t("advancing.bookDock.booked")}
                        </span>
                      ) : (
                        <BookDockSlotForm org={org} lineId={l.id} zones={zones} />
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {waiting > 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("advancing.answers.needDecision", { n: waiting })}
        </p>
      ) : null}
    </div>
  );
}
