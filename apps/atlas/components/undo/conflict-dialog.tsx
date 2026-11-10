"use client";

import { Button, Dialog } from "@xos/ui";
import { useTranslations } from "next-intl";

type Translate = (key: string, values?: Record<string, string>) => string;

/** One property both people changed: its name and each person's value, as the page shows them. */
export interface ConflictRow {
  readonly field: string;
  readonly label: string;
  readonly mine: string;
  readonly theirs: string;
}

/**
 * The mine-or-theirs choice for a stale save (Section 11.7, ADR 0077), the budget line dialog of journey 33 made
 * shared: someone saved the same properties after the person started, and nothing is overwritten until they choose.
 * Keeping mine saves again against the version that came back; taking theirs drops the person's values. Closing the
 * dialog takes theirs, so a dismissed conflict never writes.
 */
export function ConflictDialog({
  subject,
  rows,
  pending = false,
  onKeepMine,
  onTakeTheirs,
}: {
  /** What changed, such as the record's key. */
  subject: string;
  rows: readonly ConflictRow[];
  pending?: boolean;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  const t = useTranslations("collab.conflict") as unknown as Translate;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? null : onTakeTheirs())}
      title={t("title", { subject })}
      description={t("sentence")}
      actions={
        <>
          <Button onClick={onTakeTheirs} disabled={pending}>
            {t("theirs")}
          </Button>
          <Button variant="primary" loading={pending} onClick={onKeepMine}>
            {t("mine")}
          </Button>
        </>
      }
    >
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{t("title", { subject })}</caption>
        <thead>
          <tr>
            <th scope="col" className="py-4 text-start font-medium text-text-secondary">
              {t("field")}
            </th>
            <th scope="col" className="py-4 text-start font-medium text-text-secondary">
              {t("mineColumn")}
            </th>
            <th scope="col" className="py-4 text-start font-medium text-text-secondary">
              {t("theirsColumn")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field} className="border-t border-border-subtle">
              <th scope="row" className="py-6 text-start font-medium">
                {row.label}
              </th>
              <td className="py-6">{row.mine}</td>
              <td className="py-6">{row.theirs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
