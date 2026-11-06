"use client";

import { Button, Dialog, Input, Textarea, ToastRegion, UndoToast } from "@xos/ui";
import { useRouter } from "next/navigation";
import {
  createContext,
  useActionState,
  useContext,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  deleteQuoteDraftAction,
  newQuoteVersionAction,
  quoteSigningLinkAction,
  restoreQuoteDraftAction,
  saveQuoteDraftAction,
  sendQuoteAction,
  type QuoteSendState,
} from "@/app/[org]/finance/quote-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";

/**
 * The page-level client state of /finance/quotes. The Send and Signing link dialogs live here, above
 * the Draft panel: once a quote is sent its Send control leaves, so a confirmation inside it would
 * never be seen. The link and code stay on screen until the sender closes the dialog, shown once, and
 * the page refreshes only then.
 */

interface SendTarget {
  readonly kind: "send";
  readonly versionId: string;
  readonly validUntil: string;
  readonly timeZone: string;
  readonly canIssueLink: boolean;
}

interface LinkTarget {
  readonly kind: "link";
  readonly documentId: string;
  readonly validUntil: string;
  readonly timeZone: string;
}

type Target = SendTarget | LinkTarget;

interface Host {
  readonly open: (target: Target) => void;
  /** Offers Undo from the page: a deleted Draft can take its quote and this panel with it. */
  readonly draftDeleted: (draft: { quoteId: string; versionId: string }) => void;
}

const HostContext = createContext<Host>({ open: () => undefined, draftDeleted: () => undefined });

export function QuoteDialogHost({ org, children }: { org: string; children: ReactNode }) {
  const t = useFinanceT();
  const go = useQueryNav();
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const [deleted, setDeleted] = useState<{ quoteId: string; versionId: string } | null>(null);
  const [, start] = useTransition();
  return (
    <HostContext.Provider value={{ open: setTarget, draftDeleted: setDeleted }}>
      {children}
      {target ? (
        <QuoteDialog
          key={target.kind === "send" ? target.versionId : target.documentId}
          org={org}
          target={target}
          onClose={() => setTarget(null)}
        />
      ) : null}
      <ToastRegion label={t("common.notifications")}>
        {deleted ? (
          <UndoToast
            key={deleted.versionId}
            message={t("quotes.draftDeleted")}
            onUndo={() => {
              const { quoteId, versionId } = deleted;
              setDeleted(null);
              start(async () => {
                await restoreQuoteDraftAction(org, quoteId, versionId);
                go({ peek: quoteId });
                router.refresh();
              });
            }}
            onExpire={() => setDeleted(null)}
          />
        ) : null}
      </ToastRegion>
    </HostContext.Provider>
  );
}

const EMPTY: QuoteSendState = {};

function QuoteDialog({ org, target, onClose }: { org: string; target: Target; onClose: () => void }) {
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
        <input type="hidden" name="validUntil" value={target.validUntil} />
        <input type="hidden" name="timeZone" value={target.timeZone} />
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
            help={isSend ? t("quotes.send.emailHelp") : undefined}
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
export function SendQuoteButton(props: Omit<SendTarget, "kind">) {
  const t = useFinanceT();
  const { open } = useContext(HostContext);
  return (
    <Button variant="primary" onClick={() => open({ kind: "send", ...props })}>
      {t("quotes.actions.send")}
    </Button>
  );
}

export function SigningLinkButton(props: Omit<LinkTarget, "kind">) {
  const t = useFinanceT();
  const { open } = useContext(HostContext);
  return (
    <Button size="sm" onClick={() => open({ kind: "link", ...props })}>
      {t("quotes.actions.signingLink")}
    </Button>
  );
}

/** New version: a secondary action; opens the same peek once the Draft exists. */
export function NewVersionButton({ org, quoteId }: { org: string; quoteId: string }) {
  const t = useFinanceT();
  const [state, run, pending] = useActionState(newQuoteVersionAction, {});
  const [, start] = useTransition();
  return (
    <span className="inline-flex flex-col gap-4">
      <Button
        size="sm"
        loading={pending}
        onClick={() => {
          const form = new FormData();
          form.set("org", org);
          form.set("quoteId", quoteId);
          start(() => run(form));
        }}
      >
        {t("quotes.actions.newVersion")}
      </Button>
      <ActionFeedback state={state} />
    </span>
  );
}

/** Delete draft; the page offers Undo. */
export function DeleteDraftButton({
  org,
  quoteId,
  versionId,
}: {
  org: string;
  quoteId: string;
  versionId: string;
}) {
  const t = useFinanceT();
  const { draftDeleted } = useContext(HostContext);
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      icon="Trash2"
      loading={pending}
      onClick={() =>
        start(async () => {
          const result = await deleteQuoteDraftAction(org, versionId);
          if (result.ok) draftDeleted({ quoteId, versionId });
        })
      }
    >
      {t("quotes.actions.deleteDraft")}
    </Button>
  );
}

/** A Draft's Valid until and Terms. */
export function QuoteDraftForm({
  org,
  versionId,
  validUntil,
  terms,
}: {
  org: string;
  versionId: string;
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
      <input type="hidden" name="versionId" value={versionId} />
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
