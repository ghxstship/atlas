"use client";

import { Button, Dialog, Input, Select, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import {
  quoteSigningLinkAction,
  saveQuoteDraftAction,
  sendQuoteAction,
  type QuoteSendState,
} from "@/app/[org]/finance/quote-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import type { QuoteDialogTarget as Target } from "./quote-client";

/** The Send and Signing link dialog and the Draft form, which open on a press (ADR 0027). */

const EMPTY: QuoteSendState = {};

export function QuoteDialog({
  org,
  target,
  onClose,
}: {
  org: string;
  target: Target;
  onClose: () => void;
}) {
  const t = useFinanceT();
  const router = useRouter();
  const [sendState, send, sending] = useActionState(sendQuoteAction, EMPTY);
  const [linkState, link, linking] = useActionState(quoteSigningLinkAction, EMPTY);
  // A retry after a failed link goes through the link action, against the document the send created.
  const state = linkState.at ? linkState : sendState;
  const done = sendState.ok === true || linkState.ok === true;
  const close = () => {
    onClose();
    if (done) router.refresh();
  };
  if (state.link) {
    return (
      <Dialog
        open
        onOpenChange={(open) => (open ? null : close())}
        title={t("quotes.send.linkTitle")}
        description={t("quotes.send.linkOnce")}
        actions={
          <Button variant="primary" onClick={close}>
            {t("common.close")}
          </Button>
        }
      >
        <dl className="m-0 flex flex-col gap-8 text-text-13">
          <div>
            <dt className="text-text-secondary">{t("quotes.send.linkUrl")}</dt>
            <dd className="m-0 break-all font-mono text-text-12" data-testid="quote-link-url">
              {state.link.url}
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary">{t("quotes.send.accessCode")}</dt>
            <dd className="m-0 font-mono text-text-14" data-testid="quote-link-code">
              {state.link.accessCode}
            </dd>
          </div>
        </dl>
      </Dialog>
    );
  }
  if (done) {
    return (
      <Dialog
        open
        onOpenChange={(open) => (open ? null : close())}
        title={t("quotes.send.sentTitle")}
        description={
          state.noLinkTime
            ? t("quotes.send.noLinkTime")
            : state.linkFailed
              ? t("quotes.send.linkFailed")
              : t("quotes.send.signInGateway")
        }
        actions={
          <Button variant="primary" onClick={close}>
            {t("common.close")}
          </Button>
        }
      >
        <span />
      </Dialog>
    );
  }
  const isSend = target.kind === "send";
  const showEmail = !isSend || target.canIssueLink;
  const formId = "quote-send-form";
  const action = isSend ? send : link;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? null : close())}
      title={isSend ? t("quotes.actions.send") : t("quotes.actions.signingLink")}
      description={
        isSend
          ? showEmail
            ? t("quotes.send.sentence")
            : t("quotes.send.signInGateway")
          : t("quotes.send.reissueSentence")
      }
      actions={
        <>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={isSend ? sending : linking}
          >
            {isSend ? t("quotes.actions.send") : t("quotes.actions.signingLink")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        {isSend ? (
          <>
            <input type="hidden" name="versionId" value={target.versionId} />
            <Textarea
              id="quote-send-reason"
              name="reason"
              width="100%"
              label={t("quotes.send.reason")}
              help={t("common.optional")}
            />
          </>
        ) : (
          <input type="hidden" name="documentId" value={target.documentId} />
        )}
        {showEmail ? (
          <Input
            id="quote-send-email"
            name="email"
            type="email"
            width="100%"
            label={t("quotes.send.email")}
            {...(isSend ? { help: t("quotes.send.emailHelp") } : {})}
            required={!isSend}
            error={fieldError(t, state, "email")}
          />
        ) : (
          <input type="hidden" name="email" value="" />
        )}
        <ActionFeedback state={state} />
      </form>
    </Dialog>
  );
}

/** Send quote: the screen's primary action on a Draft. */
export function QuoteDraftForm({
  org,
  quoteId,
  versionId,
  title,
  engagementId,
  engagements,
  validUntil,
  terms,
}: {
  org: string;
  quoteId: string;
  versionId: string;
  title: string;
  engagementId: string | null;
  engagements: readonly { readonly value: string; readonly label: string }[] | null;
  validUntil: string;
  terms: string | null;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveQuoteDraftAction, {});
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <input type="hidden" name="versionId" value={versionId} />
      <Input
        id="quote-draft-title"
        name="title"
        required
        width="100%"
        label={t("quotes.fields.title")}
        defaultValue={title}
        error={fieldError(t, state, "title")}
      />
      {engagements ? (
        <Select
          id="quote-draft-engagement"
          name="engagementId"
          label={t("quotes.fields.engagement")}
          help={t("quotes.fields.engagementHelp")}
          value={engagementId ?? ""}
          options={[{ value: "", label: t("common.none") }, ...engagements]}
          error={fieldError(t, state, "engagementId")}
        />
      ) : null}
      <Input
        id="quote-draft-valid-until"
        name="validUntil"
        type="date"
        required
        label={t("quotes.fields.validUntil")}
        defaultValue={validUntil}
        error={fieldError(t, state, "validUntil")}
      />
      <Textarea
        id="quote-draft-terms"
        name="terms"
        width="100%"
        label={t("quotes.fields.terms")}
        defaultValue={terms ?? ""}
        error={fieldError(t, state, "terms")}
      />
      <ActionFeedback state={state} />
      <div>
        <Button type="submit" size="sm" loading={pending}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
