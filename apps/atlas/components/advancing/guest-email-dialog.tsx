"use client";

import { Button, Dialog, InlineAlert, Input, MultiSelect, Select, Textarea } from "@xos/ui";
import type { GuestEmailKind } from "@xos/data/advancing";
import { useActionState, useId, useMemo, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { sendGuestEmailAction, type GuestEmailState } from "./guest-actions";
import type { EmailableGuest } from "./guest-email-types";
import { useCopy } from "./use-copy";

/** The most guests one send takes (guest_email_batch, 2975). */
const BATCH_LIMIT = 500;

/**
 * Email guests (B8, gap G-71, app.queue_guest_emails): every guest or the ones chosen, then an invitation, their pass
 * (the A6 guest-pass PDF attached) or a message with a subject and text, in English or Spanish. A list past the batch
 * limit starts on the first 500 who can get this kind and says so. The dialog says how many will be skipped before it
 * sends; the database also suppresses addresses on the org's list, and the counts it answers say so. Every guest email
 * carries the unsubscribe link and the postal address. Loaded on demand by GuestEmailTrigger on its first hover, focus
 * or click, so the guest list carries none of its code; the trigger starts it again after a send.
 */
export function GuestEmailDialog({
  org,
  projectId,
  projectName,
  guests,
  kinds,
  locale,
  open,
  onOpenChange,
}: {
  org: string;
  projectId: string;
  projectName: string;
  guests: readonly EmailableGuest[];
  /** The kinds to offer, from the server, so no list of the database's reaches the browser for this. */
  kinds: readonly GuestEmailKind[];
  locale: "en-US" | "es-US";
  open: boolean;
  /** Whether to show it, and whether this dialog has sent, so a later opening starts again for the next send. */
  onOpenChange: (open: boolean, sent: boolean) => void;
}) {
  const t = useCopy("advancing.guests.email");
  const errors = useCopy("advancing.errors");
  const common = useCopy("advancing.common");
  const formId = useId();
  const [kind, setKind] = useState<GuestEmailKind>("Invitation");
  const [audience, setAudience] = useState<"all" | "chosen">("all");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [state, run, pending] = useActionState<GuestEmailState, FormData>(sendGuestEmailAction, {});
  const skipOf = (g: EmailableGuest) => (kind === "Pass" ? g.skip.pass : g.skip.any);
  // Those who can get this kind first, so a list past the batch limit does not spend the send on skipped guests.
  const everyone = [...guests].sort(
    (a, b) => Number(skipOf(a) !== null) - Number(skipOf(b) !== null),
  );
  const selected =
    audience === "all"
      ? everyone.slice(0, BATCH_LIMIT)
      : guests.filter((g) => chosen.includes(g.id));
  const overLimit = audience === "chosen" && selected.length > BATCH_LIMIT;
  const skipped = selected.filter((g) => skipOf(g) !== null).length;
  const sending = selected.length - skipped;
  const close = (next: boolean) => onOpenChange(next, state.ok === true);
  const preview = useMemo(
    () => t(`previews.${kind}`, { project: projectName }),
    [kind, projectName, t],
  );
  return (
    <Dialog
      title={t("title")}
      description={t("what")}
      open={open}
      onOpenChange={close}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => close(false)}>
            {common("cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={pending}
            disabled={sending === 0 || overLimit || state.ok === true}
          >
            {t("confirm", { count: sending })}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        action={run}
        onSubmit={keepInputOnSubmit(run)}
        className="flex flex-col gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="projectId" value={projectId} />
        {selected.map((g) => (
          <input key={g.id} type="hidden" name="guestId" value={g.id} />
        ))}
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
          onChange={(event) => setKind(event.target.value as GuestEmailKind)}
          options={kinds.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
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
        <Select
          id={`${formId}-audience`}
          label={t("audience")}
          value={audience}
          onChange={(event) => setAudience(event.target.value === "chosen" ? "chosen" : "all")}
          options={[
            { value: "all", label: t("audienceAll", { count: guests.length }) },
            { value: "chosen", label: t("audienceChosen") },
          ]}
        />
        {audience === "chosen" ? (
          <MultiSelect
            id={`${formId}-guests`}
            label={t("recipients")}
            value={[...chosen]}
            onChange={setChosen}
            options={guests.map((g) => {
              const skip = skipOf(g);
              return {
                value: g.id,
                label: skip ? `${g.name} (${t(`skipReasons.${skip.replace(/ /g, "")}`)})` : g.name,
              };
            })}
          />
        ) : null}
        {audience === "all" && guests.length > BATCH_LIMIT ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("batchFirst", { count: BATCH_LIMIT })}
          </p>
        ) : null}
        {overLimit ? (
          <InlineAlert tone="warning">{t("batchOver", { count: BATCH_LIMIT })}</InlineAlert>
        ) : null}
        {skipped > 0 ? (
          <p className="m-0 text-text-13 text-text-secondary" role="status">
            {t("willSkip", { count: skipped })}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
