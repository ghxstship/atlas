"use client";

import { Button, buttonClass, Dialog, InlineAlert, Input } from "@xos/ui";
import { useActionState, useState } from "react";
import { deleteAccountAction, type DeleteAccountState } from "@/lib/actions/account";

/** Copy the server translates from Compass's catalog (compass.account), so both apps say the same. */
export interface DeleteAccountCopy {
  readonly emailLabel: string;
  readonly emailHelp: string;
  readonly emailMismatch: string;
  readonly delete: string;
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly cancel: string;
  readonly refusedTitle: string;
  /** "{reason}" stands for the failure. */
  readonly failed: string;
  readonly doneTitle: string;
  /** "{count}" stands for the number of organizations told. */
  readonly doneSentence: string;
  readonly keptTitle: string;
  readonly kept: Readonly<Record<string, string>>;
  readonly done: string;
}

/**
 * Delete the account from Gateway settings (ADR 0028): type the sign-in email, confirm in a
 * dialog, and the account is deleted through the same client and contract as Compass. A refusal
 * deletes nothing and says why; on success the session ends and what is kept is listed.
 */
export function DeleteAccountForm({ email, copy }: { email: string; copy: DeleteAccountCopy }) {
  const [typed, setTyped] = useState("");
  const [state, action, pending] = useActionState<DeleteAccountState, FormData>(
    deleteAccountAction,
    {},
  );
  // The dialog is open for the answer it was opened against: it stays open while the request
  // runs and closes on any new answer, so a refusal shows under the field.
  const [openedFor, setOpenedFor] = useState<DeleteAccountState | null>(null);
  const open = openedFor === state;
  const setOpen = (next: boolean) => setOpenedFor(next ? state : null);
  const matches = typed.trim().toLowerCase() === email;
  const mismatch = typed.includes("@") && typed.trim().length >= email.length && !matches;

  if (state.deleted) {
    return (
      <section aria-labelledby="account-deleted-title" className="flex flex-col gap-12">
        <h2 id="account-deleted-title" className="m-0 text-heading-16 font-semibold">
          {copy.doneTitle}
        </h2>
        <p role="status" className="m-0 text-text-14">
          {copy.doneSentence.replace("{count}", String(state.deleted.orgsNotified))}
        </p>
        <h3 className="m-0 text-text-14 font-semibold">{copy.keptTitle}</h3>
        <ul className="m-0 flex list-disc flex-col gap-4 ps-20 text-text-13 text-text-secondary">
          {state.deleted.kept.map((k) => (
            <li key={k}>{copy.kept[k] ?? k}</li>
          ))}
        </ul>
        {/* Ends this session: the sign-in it belonged to no longer exists. */}
        <form method="post" action="/auth/sign-out">
          <button type="submit" className={buttonClass("primary", "md")}>
            {copy.done}
          </button>
        </form>
      </section>
    );
  }

  return (
    <form id="delete-account" action={action} className="flex flex-col gap-12" noValidate>
      <Input
        id="delete-account-email"
        name="email"
        type="email"
        autoComplete="email"
        label={copy.emailLabel}
        help={copy.emailHelp}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        width="100%"
        {...(mismatch ? { error: copy.emailMismatch } : {})}
      />
      {state.refused ? (
        <InlineAlert tone="danger" title={copy.refusedTitle}>
          {state.refused}
        </InlineAlert>
      ) : null}
      {state.failed ? (
        <InlineAlert tone="danger">{copy.failed.replace("{reason}", state.failed)}</InlineAlert>
      ) : null}
      <div>
        <Button
          type="button"
          variant="danger"
          icon="Trash2"
          disabled={!matches || pending}
          onClick={() => setOpen(true)}
        >
          {copy.delete}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={copy.confirmTitle}
        description={copy.confirmBody}
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {copy.cancel}
            </Button>
            <Button
              type="submit"
              form="delete-account"
              variant="danger"
              disabled={pending}
              aria-busy={pending}
            >
              {copy.delete}
            </Button>
          </>
        }
      >
        <p className="m-0 text-text-13 text-text-secondary">{copy.emailHelp}</p>
      </Dialog>
    </form>
  );
}
