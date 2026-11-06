"use client";

import { Button, Dialog, InlineAlert, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useCallback, useEffect, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  decideIntakeRequestAction,
  listIntakeRequestsAction,
  type IntakeRequestRow,
  type ProjectKeyRef,
} from "@/lib/outside-access/actions";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

function Decide({
  refs,
  row,
  onDone,
}: {
  refs: ProjectKeyRef;
  row: IntakeRequestRow;
  onDone: () => void;
}) {
  const t = useTranslations("projects.outsideAccess.requests") as unknown as Translate;
  const errors = useTranslations("projects.outsideAccess.errors") as unknown as Translate;
  const [state, dispatch, pending] = useActionState(
    async (_s: { error: string | null }, data: FormData) => {
      const result = await decideIntakeRequestAction(
        refs,
        row.request.id,
        data.get("decision") === "approve",
        String(data.get("reason") ?? ""),
      );
      if (!result.ok) return { error: result.error };
      onDone();
      return { error: null };
    },
    { error: null },
  );
  return (
    <form action={dispatch} onSubmit={keepInputOnSubmit(dispatch)} className="flex flex-col gap-8">
      {state.error ? (
        <InlineAlert tone="danger">
          {errors.has?.(state.error) === false ? errors("unexpected") : errors(state.error)}
        </InlineAlert>
      ) : null}
      <Textarea
        id={`intake-reason-${row.request.id}`}
        name="reason"
        label={t("reason")}
        help={t("reasonHelp")}
        maxLength={1000}
      />
      <div className="flex gap-8">
        <Button type="submit" size="sm" variant="secondary" name="decision" value="approve" loading={pending}>
          {t("approve")}
        </Button>
        <Button type="submit" size="sm" variant="ghost" name="decision" value="decline" loading={pending}>
          {t("decline")}
        </Button>
      </div>
    </form>
  );
}

/**
 * What arrived through the project's intake links (B2, ADR 0141), grouped by state. Party names come through
 * app.vendor_intake_request_party. Tax and payout rows read under their own policies: a holder of the Restricted
 * capabilities sees the kind and last four, everyone else only that one is on file.
 */
export function IntakeRequestsDialog({ refs, onClose }: { refs: ProjectKeyRef; onClose: () => void }) {
  const t = useTranslations("projects.outsideAccess.requests") as unknown as Translate;
  const format = useFormatter();
  const router = useRouter();
  const [rows, setRows] = useState<readonly IntakeRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    void listIntakeRequestsAction(refs).then((r) => (r.ok ? setRows(r.data) : setError(r.error)));
  }, [refs]);
  useEffect(reload, [reload]);
  const groups = ["Pending", "Approved", "Declined"] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      description={t("description")}
      actions={
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      <div className="flex flex-col gap-16">
        {error ? <InlineAlert tone="danger">{t("loadError")}</InlineAlert> : null}
        {rows === null ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("none")}</p>
        ) : (
          groups.map((state) => {
            const inState = rows.filter((r) => r.request.state === state);
            if (inState.length === 0) return null;
            return (
              <div key={state} className="flex flex-col gap-4">
                <h3 className="m-0 text-label-13 font-medium">{t(`states.${state}`)}</h3>
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                  {inState.map((row) => (
                    <li key={row.request.id} className="flex flex-col gap-8 py-8" data-intake-request={row.request.id}>
                      <span className="text-text-13">
                        {row.party?.accountName
                          ? t("partyAccount", { account: row.party.accountName, name: row.party.requesterName })
                          : (row.party?.requesterName ?? t("someone"))}
                      </span>
                      <span className="text-text-12 text-text-secondary">
                        {[
                          format.dateTime(new Date(row.request.createdAt), { dateStyle: "medium" }),
                          row.onFile.tinLast4
                            ? t("taxLast4", { kind: row.onFile.taxFormKind ?? "", last4: row.onFile.tinLast4 })
                            : row.request.taxFormId
                              ? t("taxOnFile", { kind: row.onFile.taxFormKind ?? t("taxForm") })
                              : null,
                          row.onFile.payoutLast4
                            ? t("payoutLast4", { provider: row.onFile.payoutProvider ?? "", last4: row.onFile.payoutLast4 })
                            : row.request.payoutAccountId
                              ? t("payoutOnFile")
                              : null,
                          row.request.signerName ? t("signed", { name: row.request.signerName }) : null,
                          row.request.hasInvoiceDraft ? t("invoiceDraft") : null,
                        ]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      </span>
                      {row.request.decisionReason ? (
                        <span className="text-text-12 text-text-secondary">{row.request.decisionReason}</span>
                      ) : null}
                      {state === "Pending" ? (
                        <Decide
                          refs={refs}
                          row={row}
                          onDone={() => {
                            reload();
                            router.refresh();
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
