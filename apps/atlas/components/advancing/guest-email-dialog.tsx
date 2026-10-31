"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { startTransition, useActionState, useId, useMemo, useState, type FormEvent } from "react";
import { sendGuestEmailAction, type GuestEmailState } from "./guest-actions";
import { useCopy } from "./use-copy";

type Kind = "Invitation" | "Pass" | "Message";
type Skip = "No Email" | "Not Live" | "No Pass" | null;

/** A guest the dialog can email, with why each kind would skip them. */
export interface EmailableGuest {
  readonly id: string;
  readonly name: string;
  /** Why the guest gets no Invitation or Message, and why no Pass. */
  readonly skip: { readonly any: Skip; readonly pass: Skip };
}

const KINDS: readonly Kind[] = ["Invitation", "Pass", "Message"];

/**
 * Email guests (B8, gap G-71, app.queue_guest_emails): the guests to email, chosen in the dialog, then an invitation,
 * their pass (the A6 guest-pass PDF attached) or a message with a subject and text, in English or Spanish. The dialog
 * says how many will be skipped before it sends; the database also suppresses addresses on the org's list, and the
 * counts it answers say so. Every guest email carries the unsubscribe link and the postal address. Loaded with
 * next/dynamic from the guest list, so no other page carries its code.
 */
export function GuestEmailDialog({
  org,
  projectId,
  projectName,
  guests,
  locale,
}: {
  org: string;
  projectId: string;
  projectName: string;
  guests: readonly EmailableGuest[];
  locale: "en-US" | "es-US";
}) {
  const t = useCopy("advancing.guests.email");
  const errors = useCopy("advancing.errors");
  const common = useCopy("advancing.common");
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("Invitation");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(guests.map((g) => g.id)));
  const [state, run, pending] = useActionState<GuestEmailState, FormData>(sendGuestEmailAction, {});
  const skipOf = (g: EmailableGuest) => (kind === "Pass" ? g.skip.pass : g.skip.any);
  const selected = guests.filter((g) => chosen.has(g.id));
  const skipped = selected.filter((g) => skipOf(g) !== null).length;
  const sending = selected.length - skipped;
  const preview = useMemo(
    () => t(`previews.${kind}`, { project: projectName }),
    [kind, projectName, t],
  );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    for (const g of selected) data.append("guestId", g.id);
    startTransition(() => run(data));
  };
  return (
    <Dialog
      title={t("title")}
      description={t("what")}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" icon="Mail">
          {t("action")}
        </Button>
      }
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {common("cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={pending}
            disabled={sending === 0 || state.ok === true}
          >
            {t("confirm", { count: sending })}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="projectId" value={projectId} />
        {state.error ? (
          <InlineAlert tone="danger" title={errors("title")}>
            {errors(state.error)}
          </InlineAlert>
        ) : null}
        {state.ok && state.summary ? (
          <InlineAlert tone="success" title={t("sent", { count: state.summary.queued })}>
            {[
              state.summary.suppressed > 0
                ? t("willSuppress", { count: state.summary.suppressed })
                : null,
              state.summary.skipped > 0 ? t("willSkip", { count: state.summary.skipped }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </InlineAlert>
        ) : null}
        <Select
          id={`${formId}-kind`}
          name="kind"
          label={t("kind")}
          value={kind}
          onChange={(event) => setKind(event.target.value as Kind)}
          options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
        />
        {kind === "Message" ? (
          <Input
            id={`${formId}-subject`}
            name="subject"
            required
            maxLength={150}
            width="100%"
            label={t("subject")}
            help={t("subjectHelp")}
          />
        ) : null}
        <Textarea
          id={`${formId}-body`}
          name="body"
          maxLength={5000}
          width="100%"
          required={kind === "Message"}
          label={kind === "Message" ? t("body") : t("note")}
          help={kind === "Message" ? t("bodyHelp") : t("noteHelp")}
        />
        <Select
          id={`${formId}-locale`}
          name="locale"
          label={t("language")}
          value={locale}
          options={[
            { value: "en-US", label: "English" },
            { value: "es-US", label: "Español" },
          ]}
        />
        <section aria-labelledby={`${formId}-preview`} className="flex flex-col gap-4">
          <h3 id={`${formId}-preview`} className="m-0 text-text-13 font-semibold">
            {t("preview")}
          </h3>
          <p className="m-0 rounded-card border border-border-subtle p-12 text-text-13">
            {preview}
          </p>
        </section>
        <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
          <legend className="text-text-13 font-semibold">{t("recipients")}</legend>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {guests.map((g) => {
              const skip = skipOf(g);
              return (
                <li key={g.id}>
                  <Checkbox
                    id={`${formId}-${g.id}`}
                    label={
                      skip ? `${g.name} (${t(`skipReasons.${skip.replace(/ /g, "")}`)})` : g.name
                    }
                    checked={chosen.has(g.id)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(g.id);
                        else next.delete(g.id);
                        return next;
                      });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </fieldset>
        {skipped > 0 ? (
          <p className="m-0 text-text-13 text-text-secondary" role="status">
            {t("willSkip", { count: skipped })}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
