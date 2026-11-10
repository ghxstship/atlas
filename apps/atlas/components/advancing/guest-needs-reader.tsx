"use client";

import type { GuestNeeds } from "@xos/data/sensitive-consent";
import { Button, Dialog, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { readGuestNeedsAction } from "./guest-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The guests' needs for a holder of data.restricted.read.medical on the project (ADR 0164): read when the dialog opens,
 * and read again as a logged export when downloaded. Standard exports never carry these columns (0530).
 */
export function GuestNeedsReader({
  org,
  projectId,
  onClose,
}: {
  org: string;
  projectId: string;
  onClose: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const needsT = (key: string) => t(`consent.guestNeeds.${key}`);
  const [rows, setRows] = useState<readonly GuestNeeds[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void readGuestNeedsAction(org, projectId, false).then((r) => {
      if (!live) return;
      if (r.ok) setRows(r.rows);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [org, projectId]);
  const needs = (values: readonly string[], list: string) =>
    values
      .map((v) =>
        t(
          `${list}.${v.replace(/[^A-Za-z0-9]+(.)?/g, (_, c?: string) => (c ? c.toUpperCase() : "")).replace(/^./, (f) => f.toLowerCase())}`,
        ),
      )
      .join(", ");
  const download = async () => {
    const result = await readGuestNeedsAction(org, projectId, true);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `guest-needs-${projectId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={needsT("readTitle")}
      description={needsT("readHelp")}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {needsT("close")}
          </Button>
          {rows && rows.length > 0 ? (
            <Button variant="primary" type="button" onClick={() => void download()}>
              {needsT("download")}
            </Button>
          ) : null}
        </>
      }
    >
      {failed ? (
        <InlineAlert tone="danger" title={needsT("readTitle")}>
          {t("errors.unexpected")}
        </InlineAlert>
      ) : rows === null ? null : rows.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{needsT("readNone")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0 text-text-13">
          {rows.map((r) => (
            <li key={r.guestListEntryId} className="flex flex-col gap-2 py-8">
              <strong>{r.guestName}</strong>
              {[
                needs(r.dietaryNeeds, "dietaryNeeds"),
                r.allergies,
                r.dietaryNotes,
                needs(r.accessibilityNeeds, "accessibilityNeeds"),
                r.accessibilityNotes,
              ]
                .filter(Boolean)
                .map((line) => (
                  <span key={line}>{line}</span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
