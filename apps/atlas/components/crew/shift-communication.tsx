import type { CommunicationStatus } from "@xos/data/change-tracking";
import { historyLabelKey } from "@/lib/history/fields";
import type { Translate } from "@/lib/shell/translate";
import { ConfirmButton } from "./forms-confirm-button";
import { markCommunicatedAction } from "@/app/[org]/crew/actions";

/**
 * Needs review and Mark as communicated on Crew > Shifts (B6, G-120, ADR 0145): whether the person on
 * a shift was told of its changes, from app.communication_status (2951). The wording is shared by
 * the table's Told column, the list's tag, the calendar and schedule labels and the peek's
 * Communication section.
 */

/** The tag of a shift's Told state, or null when it has no status (open, past, or not the viewer's to write). */
export function toldTag(
  status: CommunicationStatus | undefined,
  t: Translate,
): { readonly label: string; readonly needsReview: boolean } | null {
  if (!status || status.personId === null) return null;
  if (status.needsReview) {
    return {
      label:
        status.toldAt !== null && status.changedFields.length > 0
          ? `${t("crew.communication.needsReview")} · ${t("crew.communication.changesSinceTold", { count: status.changedFields.length })}`
          : t("crew.communication.needsReview"),
      needsReview: true,
    };
  }
  return {
    label: t(status.toldAt !== null ? "crew.communication.told" : "crew.communication.notTold"),
    needsReview: false,
  };
}

/** The peek's Communication section: who was told when and how, what changed since, and Mark as communicated. */
export function CommunicationSection({
  status,
  org,
  shiftId,
  t,
  when,
}: {
  status: CommunicationStatus;
  org: string;
  shiftId: string;
  t: Translate;
  /** An instant in the viewer's format. */
  when: (iso: string) => string;
}) {
  const date = status.toldAt ? when(status.toldAt) : "";
  const line =
    status.toldVia === "notified"
      ? t("crew.communication.toldNotified", { date })
      : status.toldVia === "accepted"
        ? t("crew.communication.toldAccepted", {
            name: status.personName ?? t("crew.common.unnamed"),
            date,
          })
        : status.toldVia === "marked"
          ? t("crew.communication.toldMarked", {
              name: status.toldByName ?? t("crew.common.unnamed"),
              date,
            })
          : t("crew.communication.notTold");
  const fields = status.changedFields.flatMap((f) => {
    const key = historyLabelKey(f);
    return key ? [t(key)] : [];
  });
  return (
    <section aria-labelledby="shift-communication" className="flex flex-col gap-8">
      <h2 id="shift-communication" className="m-0 text-text-13 font-semibold">
        {t("crew.communication.title")}
      </h2>
      <p className="m-0 text-text-13" data-testid="shift-told-line">
        {line}
      </p>
      {status.needsReview && fields.length > 0 ? (
        <p className="m-0 text-text-12 text-warning-text">
          {t("crew.communication.changedFields", { fields: fields.join(", ") })}
        </p>
      ) : null}
      <div>
        <ConfirmButton
          label={t("crew.communication.markOne")}
          title={t("crew.communication.markTitle")}
          description={t("crew.communication.markHelp")}
          defaultReason={t("crew.communication.markReason")}
          action={markCommunicatedAction}
          hidden={{ org, ids: shiftId }}
          variant={status.needsReview ? "primary" : "secondary"}
        />
      </div>
    </section>
  );
}
