"use client";

import { Button, ToastRegion, UndoToast } from "@xos/ui";
import dynamic from "next/dynamic";
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
  restoreQuoteDraftAction,
} from "@/app/[org]/finance/quote-actions";
import { ActionFeedback } from "./kit-action-feedback";
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
  readonly canIssueLink: boolean;
}

interface LinkTarget {
  readonly kind: "link";
  readonly documentId: string;
}

export type QuoteDialogTarget = SendTarget | LinkTarget;
type Target = QuoteDialogTarget;

interface Host {
  readonly open: (target: Target) => void;
  /** Offers Undo from the page: a deleted Draft can take its quote and this panel with it. */
  readonly draftDeleted: (draft: { quoteId: string; versionId: string }) => void;
}

const QuoteDialog = dynamic(() => import("./quote-dialogs").then((m) => m.QuoteDialog));

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

/**
 * A Draft's title, client engagement, Valid until and Terms. The engagement is chosen here until a
 * version was sent, so a quote created without one can still reach Send. engagements is null once it
 * is fixed.
 */

export const QuoteDraftForm = dynamic(() =>
  import("./quote-dialogs").then((m) => m.QuoteDraftForm),
);
