"use client";

import { Dialog, Textarea } from "@xos/ui";
import { rejectInboxAction } from "@/app/[org]/inbox/actions";
import { ActionForm, usePlatformT } from "@/components/platform/kit";

/** Reject an approval with a reason, from the inbox. Its own module: it loads with the first Reject. */
export function RejectDialog({
  org,
  id,
  summary,
  onClose,
  onRejected,
}: {
  org: string;
  id: string;
  summary: string;
  onClose: () => void;
  onRejected: () => void;
}) {
  const t = usePlatformT();
  return (
    <Dialog
      title={t("inbox.rejectTitle")}
      open
      onOpenChange={(open) => (open ? null : onClose())}
      actions={null}
    >
      <p className="m-0 text-text-13">{summary}</p>
      <ActionForm
        action={rejectInboxAction}
        hidden={{ org, id }}
        label={t("inbox.rejectTitle")}
        submitLabel={t("inbox.rejectSubmit")}
        submitVariant="danger"
        onDone={onRejected}
      >
        <Textarea
          id="reject-reason"
          name="reason"
          label={t("inbox.rejectReason")}
          required
          maxLength={2000}
          rows={3}
          width="100%"
          autoFocus
        />
      </ActionForm>
    </Dialog>
  );
}
